# Codebase Structure

**Analysis Date:** 2026-09-02

## Directory Layout

```
flawchess/
├── app/                     # FastAPI backend
│   ├── core/                # Config, DB session factory, rate limiters, dev clock
│   ├── data/                # Static/reference data used by services
│   ├── middleware/          # ASGI middleware (e.g. last-activity tracking)
│   ├── models/               # SQLAlchemy 2.x async ORM models
│   ├── prompts/              # LLM prompt templates for insights narration
│   ├── repositories/          # All DB access (SQLAlchemy select/update/insert)
│   ├── routers/               # FastAPI APIRouter modules — HTTP layer only
│   ├── schemas/                # Pydantic v2 request/response contracts
│   ├── services/                # Business logic (import, eval, stats, LLM, training)
│   └── main.py                  # ASGI app, lifespan, router wiring
├── alembic/                 # DB migrations
│   ├── versions/             # One file per migration
│   └── env.py                 # Alembic runtime config
├── analysis/                # Standalone research code, own uv venv/lockfile
│   ├── engine_disagreement_study/  # Stockfish/Maia disagreement research (marimo notebooks)
│   ├── game_review_study/          # Game review research
│   ├── db.py                        # Read-only DB access for analysis scripts
│   └── out/                          # Generated artifacts (plots, etc.)
├── bin/                     # Operational shell scripts (deploy, reset_db, tunnels)
├── docs/                    # Reference docs (runbook, git workflow, dev tooling)
├── fixtures/                # Test fixtures (e.g. tactic-tagger CC0 puzzle set)
├── frontend/                # React 19 + TypeScript + Vite SPA
│   ├── public/                # Static assets, including vendored Maia ONNX model
│   └── src/
│       ├── api/                # Typed HTTP client to backend (client.ts)
│       ├── assets/               # Images, persona portraits
│       ├── components/            # Feature/domain components, organized by area
│       ├── data/                    # Static frontend data (e.g. opening names)
│       ├── generated/                # Auto-generated from scripts/gen_*.py — CI drift-checked
│       ├── hooks/                     # TanStack Query + local state hooks
│       ├── lib/                        # Client-side chess engine, personas, utilities
│       │   ├── engine/                  # Stockfish WASM + Maia ONNX orchestration
│       │   └── personas/                 # Bot persona definitions
│       ├── pages/                          # Route-level screens
│       │   ├── activity/
│       │   ├── library/
│       │   └── openings/
│       └── types/                            # Shared TypeScript types
├── scripts/                 # One-off/maintenance Python scripts (backfills, generators)
├── stories/                 # Public data-story static site (stories.flawchess.com)
│   └── two-pawns-up/          # One story: HTML page + source markdown report
├── tests/                   # Backend pytest suite, mirrors app/ layout
├── docker-compose*.yml       # Dev DB, worker, benchmark-DB, full-stack compose files
├── Dockerfile / Dockerfile.worker  # Backend image / lean remote-worker image
├── pyproject.toml            # Backend deps (uv), dependency-groups (dev, maia-inference)
└── CLAUDE.md                 # Project-wide agent instructions
```

## Directory Purposes

**`app/routers/`:**
- Purpose: HTTP layer — request parsing, auth, response shaping.
- Contains: `APIRouter(prefix=..., tags=[...])` modules, one per resource domain.
- Key files: `app/routers/eval_remote.py` (remote worker lease/submit protocol), `app/routers/imports.py`, `app/routers/openings.py`, `app/routers/endgames.py`, `app/routers/train.py`, `app/routers/insights.py`, `app/routers/admin.py`, `app/routers/admin_activity.py`.

**`app/services/`:**
- Purpose: all business logic; the largest and most active directory in the backend.
- Contains: 40+ modules; largest are `endgame_service.py` (~3800 lines), `eval_apply.py` (~2800), `tactic_detector.py` (~2600), `insights_llm.py` (~2600), `library_service.py`, `import_service.py`.
- Key files: `app/services/engine.py` (Stockfish pool), `app/services/maia_engine.py` (Maia ONNX), `app/services/zobrist.py` (position hashing), `app/services/eval_drain.py` + `eval_entry.py` + `eval_apply.py` + `eval_queue_service.py` (eval pipeline), `app/services/chesscom_client.py` + `lichess_client.py` + `normalization.py` (import), `app/services/insights_llm.py` + `insights_service.py` (LLM narration), `app/services/flaws_service.py` + `tactic_detector.py` (flaw/tactic classification).

**`app/repositories/`:**
- Purpose: sole location for DB queries.
- Contains: one file per aggregate/domain, plus `query_utils.py` for shared filter logic.
- Key files: `app/repositories/game_repository.py`, `app/repositories/query_utils.py` (`apply_game_filters()`), `app/repositories/openings_repository.py`, `app/repositories/stats_repository.py`, `app/repositories/user_benchmark_percentiles_repository.py`.

**`app/models/`:**
- Purpose: ORM table definitions.
- Contains: one file per table, all inheriting `app/models/base.py`.
- Key files: `app/models/game.py`, `app/models/game_position.py`, `app/models/game_flaw.py`, `app/models/game_best_move.py`, `app/models/import_job.py`, `app/models/eval_jobs.py`, `app/models/worker_heartbeat.py`, `app/models/user.py`.

**`app/core/`:**
- Purpose: cross-cutting infrastructure shared by all layers.
- Contains: `config.py` (settings), `database.py` (async session factory/engine), `dev_clock.py` (`dev_now_utc` dependency), `rate_limiters.py`, `ip_rate_limiter.py`, `http.py` (shared `USER_AGENT`), `opponent_strength.py`, `platform_usernames.py`.

**`app/schemas/`:**
- Purpose: Pydantic v2 API contracts, one file per router domain (matching names).
- Key files: `app/schemas/normalization.py` (`NormalizedGame`, `TimeControlBucket` — used at the import client boundary).

**`alembic/versions/`:**
- Purpose: append-only migration history driving Postgres schema evolution.
- Naming: Alembic autogenerated revision IDs + short slug, e.g. `<rev>_<description>.py`.

**`frontend/src/components/`:**
- Purpose: React components grouped by feature/domain, not by component type.
- Subdirectories: `admin/`, `analysis/`, `auth/`, `board/`, `bots/`, `charts/`, `feedback/`, `filters/`, `icons/`, `insights/`, `install/`, `layout/`, `library/`, `move-explorer/`, `popovers/`, `position-bookmarks/`, `results/`, `stats/`, `train/`, `ui/` (generic primitives, e.g. shadcn-style components).

**`frontend/src/lib/engine/`:**
- Purpose: client-side chess engine used for bot play/training — entirely separate from the server-side analysis engine.
- Key files: `stockfishWorkerSource.ts`, `maiaWorkerHost.ts`, `maiaQueue.ts`, `maiaPolicyCache.ts`, `mctsSearch.ts`, `fallbackExpectimax.ts`, `selectBotMove.ts`, `botStyleBundles.ts`, `workerPool.ts`, `openingBook.ts`, `engineAssetCache.ts`.

**`frontend/src/hooks/`:**
- Purpose: TanStack Query data-fetching hooks (`useXyz.ts` wraps `api/client.ts`) plus local UI/filter state hooks.
- Key files: `useAuth.ts`, `useImport.ts`, `useFilterStore.ts`, `useFlawFilterStore.ts`, `useFlawChessEngine.ts`, `useEndgames.ts`, `useLibrary.ts`, `useEvalCoverage.ts`.

**`frontend/src/generated/`:**
- Purpose: files regenerated by `scripts/gen_*.py` (e.g. opening name tables). CI fails on drift — always re-run the generator after editing its source registry.
- Generated: Yes. Committed: Yes.

**`analysis/`:**
- Purpose: standalone data-science research code (marimo notebooks + scripts), never imported by `app/`.
- Isolation: own `pyproject.toml`/`uv.lock`/`.venv` — checked with `uv run --project analysis --with ty ty check analysis/`, not the main `ty` invocation.
- Contains: `analysis/db.py` (read-only DB access), `analysis/engine_disagreement_study/`, `analysis/game_review_study/`.

**`stories/`:**
- Purpose: static public data-story pages at stories.flawchess.com, built and deployed independently of the main SPA.
- Contains: one directory per story (e.g. `stories/two-pawns-up/`), each with an `index.html` and a source markdown report (`*-report-latest.md`).
- Scoped rules: `stories/CLAUDE.md`.

**`scripts/`:**
- Purpose: one-off/maintenance Python scripts run via `uv run scripts/<name>.py` — backfills, benchmark generators, code generators (`gen_*.py`).
- Generated: some scripts write to `frontend/src/generated/`.

**`bin/`:**
- Purpose: operational shell scripts. `bin/deploy.sh` is the only sanctioned deploy path; `bin/reset_db.sh` destroys the dev DB (never run without explicit user permission); `bin/prod_db_tunnel.sh`, `bin/benchmark_db.sh` set up read-only DB MCP tunnels.

**`tests/`:**
- Purpose: backend pytest suite, directory structure mirrors `app/` (routers/services/repositories test subdirectories).
- Isolation: each session clones its own Postgres DB from a migrated template (`tests/conftest.py`); auto-refreshes on Alembic head change.

## Key File Locations

**Entry Points:**
- `app/main.py`: FastAPI app, lifespan startup/shutdown (engine pools, background tasks), router registration.
- `frontend/src/main.tsx`: SPA bootstrap, service worker update handling.
- `frontend/src/App.tsx`: React Router route table.

**Configuration:**
- `app/core/config.py`: backend settings (Pydantic settings, env-driven).
- `.env` / `.env.example` (root): shared env vars for backend + frontend (frontend Vite config loads `.env` from project root, not `frontend/.env`).
- `frontend/vite.config.ts`: Vite build config, PWA plugin, prerender plugin.
- `alembic.ini` + `alembic/env.py`: migration runtime config.
- `pyproject.toml`: backend dependencies, dependency-groups (`dev`, `maia-inference` — isolated ONNX/numpy group kept out of the lean worker image).

**Core Logic:**
- `app/services/zobrist.py`: position hashing, core product differentiator.
- `app/services/engine.py`: server-side Stockfish pool.
- `app/services/maia_engine.py`: server-side Maia-3 ONNX policy inference.
- `app/services/eval_apply.py`: atomic write-path for remote worker eval submissions.
- `app/services/import_service.py`: import job orchestration.
- `frontend/src/lib/engine/selectBotMove.ts`: client-side bot move selection.

**Testing:**
- `tests/` (backend, pytest, mirrors `app/`).
- `frontend/src/**/__tests__/` and co-located `*.test.tsx`/`*.test.ts` (frontend, Vitest).
- `fixtures/`: shared test fixtures (e.g. tactic-tagger CC0 puzzle CSVs).

## Naming Conventions

**Files:**
- Backend: `snake_case.py` throughout (`import_service.py`, `game_repository.py`).
- Frontend hooks: `useXyz.ts` (PascalCase-after-use prefix, e.g. `useEndgames.ts`, `useFlawChessEngine.ts`).
- Frontend components: `PascalCase.tsx` (e.g. `Openings.tsx`, one component per file).
- Frontend tests: co-located `*.test.ts`/`*.test.tsx` or under a sibling `__tests__/` directory — both patterns exist side by side.
- Backend service/repository files are named after their domain noun, singular-vs-plural following the underlying table/concept (`flaws_service.py`, `game_repository.py`).

**Directories:**
- Backend layered dirs are flat singular-noun-plural (`routers`, `services`, `repositories`, `models`, `schemas`) — no further nesting within them.
- Frontend `components/` nests by feature/domain (`components/train/`, `components/library/`), not by component type (no `atoms/molecules/organisms`).
- Migration files live flat inside `alembic/versions/` (no subdirectory grouping).

## Where to Add New Code

**New Backend Feature (e.g. new resource/endpoint):**
- Router: add or extend a file in `app/routers/` with `APIRouter(prefix="/resource", tags=["resource"])`; use relative paths in decorators.
- Service: add business logic in a new or existing `app/services/*.py` file — never embed SQL here.
- Repository: add query functions in `app/repositories/*.py`; reuse `app/repositories/query_utils.py::apply_game_filters()` for any standard game filtering.
- Schema: add Pydantic request/response models in `app/schemas/*.py`, matching the router filename.
- Model (if new table): add to `app/models/*.py` with explicit `ForeignKey(..., ondelete=...)` and any needed `UniqueConstraint`; generate migration via `uv run alembic revision --autogenerate -m "description"`.
- Tests: mirror the new file's path under `tests/` (e.g. `app/services/foo.py` → `tests/services/test_foo.py`).

**New Frontend Feature:**
- Page: add to `frontend/src/pages/` (or a subdirectory like `pages/library/` for a page cluster), wire into `frontend/src/App.tsx` route table.
- Components: add under the matching domain subdirectory in `frontend/src/components/` (create a new subdirectory only for a genuinely new feature area).
- Data fetching: add a `useXyz.ts` hook in `frontend/src/hooks/` wrapping `frontend/src/api/client.ts`.
- Shared UI primitives: `frontend/src/components/ui/`.

**Client-side chess engine changes (bot play/training):**
- All engine orchestration logic belongs in `frontend/src/lib/engine/` — keep worker-boundary code (`stockfishWorkerSource.ts`, `maiaWorkerHost.ts`) separate from move-selection/search logic (`selectBotMove.ts`, `mctsSearch.ts`, `fallbackExpectimax.ts`).

**Utilities:**
- Backend shared helpers with no clear service home: prefer adding to `app/core/` only if truly cross-cutting infrastructure; otherwise keep logic inside the owning service.
- Frontend shared helpers: `frontend/src/lib/` (non-engine utilities) or a co-located hook in `frontend/src/hooks/`.

**Distributed eval worker protocol changes:**
- Server-side protocol endpoints: `app/routers/eval_remote.py`.
- Apply/write logic: `app/services/eval_apply.py`, `app/services/eval_queue_service.py`.
- Any new endpoint must document expected non-exception status codes (204/401/403/422/404) at the top of `eval_remote.py`, matching the existing convention.

## Special Directories

**`app/**/__pycache__/`:**
- Purpose: Python bytecode cache.
- Generated: Yes. Committed: No.

**`frontend/src/generated/`:**
- Purpose: code generated from source registries via `scripts/gen_*.py`.
- Generated: Yes. Committed: Yes (drift-checked in CI — must be regenerated and committed after editing the source registry).

**`analysis/.venv/`, `analysis/out/`:**
- Purpose: isolated Python environment and generated research artifacts for `analysis/`.
- Generated: Yes. Committed: `.venv` no; some `out/` artifacts (e.g. reference PNGs) are committed.

**`reports/`:**
- Purpose: timestamped generated reports (DB stats, tactic-tagger precision, benchmarks) written by project skills/scripts.
- Generated: Yes. Committed: Yes (historical record).

**`htmlcov/`, `.coverage`:**
- Purpose: pytest coverage output.
- Generated: Yes. Committed: appears present in working tree but should generally be treated as disposable/regeneratable.

**`.planning/`:**
- Purpose: GSD (Open GSD) project management artifacts — roadmap, phase plans, codebase maps (this document's own location).
- Generated: partially (this doc, other `.planning/codebase/*.md`). Committed: Yes.

---

*Structure analysis: 2026-09-02*
