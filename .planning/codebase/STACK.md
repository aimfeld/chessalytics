# Technology Stack

**Analysis Date:** 2026-09-02

## Languages

**Primary:**
- Python 3.13 (`requires-python = ">=3.13"` in `pyproject.toml`) — backend, `app/`, `scripts/`, `tests/`, `analysis/`
- TypeScript ~6.0.3 — frontend SPA, `frontend/src/`

**Secondary:**
- SQL — Alembic migrations (`alembic/versions/`), raw SQL in `app/services/canonical_slice_sql.py`
- Shell — `bin/*.sh` (deploy, dev-DB, tunnels, sweeps)
- HTML/CSS — `stories/` static data-story pages (no framework, hand-written)

## Runtime

**Environment:**
- Python 3.13, pinned via `.python-version`
- Node.js — version not pinned by `.nvmrc` (absent); frontend `devDependencies` target modern ESM tooling (Vite 8, TS 6)

**Package Manager:**
- Backend: `uv` (root project). Lockfile: `uv.lock` (present, committed)
- `analysis/` is a **separate standalone uv project** with its own lockfile/venv (`analysis/pyproject.toml`, `analysis/uv.lock`) — deliberately not a uv workspace member (see comment in `analysis/pyproject.toml`: workspace layout breaks the Docker cacheable-layer build and would prune `marimo` on every `uv sync --group maia-inference` in `bin/run_local.sh`)
- Frontend: `npm`, lockfile `frontend/package-lock.json` (implied by `npm install`/`npm ci` usage in CLAUDE.md and skill notes)
- `stories/` — static site, no package.json / build step found (plain HTML/CSS/JS under `stories/two-pawns-up/`)

## Frameworks

**Core (backend):**
- FastAPI `>=0.115.0` (`[standard]` extra) — HTTP API, `app/main.py`, `app/routers/`
- Uvicorn `>=0.30.0` (`[standard]` extra) — ASGI server
- SQLAlchemy `>=2.0.0` async (`[asyncio]` extra) — ORM, `select()` API only (not legacy `Query`), `app/models/`, `app/repositories/`
- Alembic `>=1.13.0` — schema migrations, `alembic/versions/`
- Pydantic v2 `>=2.0.0` + `pydantic-settings>=2.0.0` — validation and settings (`app/core/config.py`)
- FastAPI-Users `>=15.0.4` (`[oauth,sqlalchemy]`) — auth, `app/users.py`, `app/routers/auth.py`, `app/routers/users.py`, `app/models/user.py`, `app/models/oauth_account.py`
- pydantic-ai-slim `>=2.31,<3.0` (`[anthropic,google]` extras) — LLM-narrated insights, `app/services/insights_llm.py`

**Core (frontend):**
- React `^19.2.8` + `react-dom` — UI
- Vite `^8.0.14` + `@vitejs/plugin-react` — build/dev server
- TanStack Query `^5.100.14` — server-state/data fetching
- React Router `^8.3.0` — routing
- Tailwind CSS `^4.3.0` (`@tailwindcss/vite`) — styling
- react-chessboard `^5.10.0` + chess.js `^1.4.0` — board rendering and move legality
- Radix UI (`radix-ui ^1.4.3`) + shadcn (`shadcn ^4.9.0`, generator only) — component primitives
- Recharts `^3.8.1` — charts
- vite-plugin-pwa `^1.3.0` + vite-prerender-plugin `^0.5.13` — PWA/prerendering

**Testing:**
- Backend: pytest `>=8.0.0`, pytest-asyncio `>=0.23.0` (`asyncio_mode = "auto"`), pytest-cov `>=7.1.0`, pytest-xdist `>=3.8.0` (enables `-n auto`)
- Frontend: Vitest `^4.1.7` + `@vitest/coverage-v8` + `@vitest/ui`, `@testing-library/react ^16.3.2`, jsdom `^29.1.1`

**Build/Dev:**
- ruff `>=0.4.0` — Python lint + format (`line-length = 100` in `[tool.ruff]`)
- ty `>=0.0.26` — Python type checker (Astral), zero-error gate in CI; root config excludes `analysis/` (`[tool.ty.src] exclude = ["analysis"]`) which is checked separately via `uv run --project analysis --with ty ty check analysis/`
- ESLint `^10.4.1` + `typescript-eslint ^8.60.0` — frontend lint (no Prettier — ESLint-only, per project convention)
- knip `^6.15.0` — frontend dead-code/unused-export detection (`npm run knip`)
- audit-ci `^7.1.0` — frontend vulnerability gate in CI, driven by `frontend/audit-ci.jsonc` allowlist (not raw `npm audit`)

**Chess engines:**
- Stockfish — native UCI binary on the backend (long-lived process managed in `app/main.py` lifespan, `start_engine`/`stop_engine`); `stockfish 18.0.8` npm package + WASM build vendored on the frontend for client-side play/eval (`frontend/src/hooks/useStockfishEngine.ts`)
- Maia-3 — ONNX policy-network model for human-like move prediction. Backend: `onnxruntime==1.20.1` (exact pin — newer versions segfault on the vendored `maia3_simplified.onnx`), isolated `maia-inference` uv dependency group so it never ships in the lean remote-worker image. Frontend: `onnxruntime-web 1.27.0` (WebGPU/WASM inference in-browser)

## Key Dependencies

**Critical:**
- `chess >=1.10.0` (python-chess 1.11.x per CLAUDE.md) — PGN parsing, board/move logic, Zobrist-adjacent FEN handling, `app/services/zobrist.py`
- `httpx >=0.27.0` — the only sanctioned async HTTP client (never `requests`/`berserk`); used for chess.com/lichess fetches and outbound calls
- `httpx-oauth >=0.16.1` — OAuth client library backing FastAPI-Users' Google OAuth flow
- `asyncpg >=0.29.0` — async PostgreSQL driver under SQLAlchemy's async engine
- `genai-prices >=0.1.3,<0.2.0` — LLM cost/pricing lookups for insights cost attribution

**Infrastructure:**
- `sentry-sdk[fastapi] >=2.54.0` — backend error/trace monitoring, initialized in `app/main.py`
- `@sentry/react ^10.55.0` — frontend error monitoring, `frontend/src/instrument.ts`
- `cryptography >=50.0.0` + `pyjwt >=2.10.1` — isolated `push` uv dependency group backing vendored Web Push encryption (`app/services/push_crypto.py`, MIT-licensed ~110-line vendor of webpush-py 1.0.6, not a third-party push package)
- `zstandard >=0.22` (dev group) — compression, likely fixture/dump handling in `scripts/`/`tests/`

## Configuration

**Environment:**
- `.env` (gitignored, local secrets) loaded via `python-dotenv` in `app/core/config.py` (`load_dotenv()` called explicitly so third-party libs reading env vars directly, e.g. pydantic-ai's `GoogleProvider` reading `GOOGLE_API_KEY`, also see it)
- `.env.example` — committed template enumerating all settings
- `.prod.env` — production env reference (present in repo root; actual prod secrets live only on the server, per `docs/production-runbook.md`)
- Settings resolved through a single `pydantic_settings.BaseSettings` class (`app/core/config.py`), covering: 4 `DATABASE_URL_*` variants (dev/test/prod/benchmark, resolved via `db_url_for_target()`), `SECRET_KEY` (deploy-blocker if left default outside `ENVIRONMENT=development`), Google OAuth client id/secret, `SENTRY_DSN`/`SENTRY_TRACES_SAMPLE_RATE`, `PYDANTIC_AI_MODEL_INSIGHTS` + Gemini thinking knobs, VAPID Web Push keypair, `RESEND_API_KEY`/`MAIL_FROM`, and several feature-flag booleans gating eval-drain/backfill/benchmark-lane behavior

**Build:**
- Backend: `pyproject.toml` (root), `analysis/pyproject.toml` (separate project)
- Frontend: `frontend/vite.config.ts` (not read in detail here — see `frontend/CLAUDE.md` for styling/testid conventions), `frontend/tsconfig*.json`, Tailwind v4 config via `@tailwindcss/vite` plugin (no separate `tailwind.config.js` — Tailwind 4 CSS-first config)
- Alembic: `alembic.ini` + `alembic/env.py`

## Platform Requirements

**Development:**
- Docker + Docker Compose for the dev database: `docker-compose.dev.yml` runs `postgres:18-alpine` with `pg_stat_statements` preloaded, `shm_size: 256m` (Docker's 64MB default is exhausted by parallel-query DSM segments), named volume `devpgdata`, seeded via `deploy/init-dev-db.sql`
- `bin/run_local.sh` — starts backend (`uv sync --group maia-inference` + uvicorn) and presumably frontend dev server
- Stockfish binary installed locally via `bin/install_stockfish.sh`
- No SQLite anywhere — PostgreSQL only, including for tests (isolated per-session cloned DB, see `tests/conftest.py`)

**Production:**
- Docker-based deployment: `Dockerfile` (backend app image) and `Dockerfile.worker` (lean remote eval-worker image — deliberately excludes `maia-inference`/`push` uv groups and the analysis stack)
- `docker-compose.yml` — full production stack (backend, Caddy reverse proxy, likely Postgres/Umami)
- `docker-compose.worker.yml` — remote eval-worker fleet composition
- `docker-compose.benchmark.yml` — separate benchmark backend instance (`:8001`) against a benchmark Postgres on `:5433`
- Caddy — reverse proxy and TLS termination, `deploy/Caddyfile`; provides same-origin routing in production (CORS only enabled in dev)
- `deploy/cloud-init.yml` — server provisioning
- `deploy/entrypoint.sh` — container entrypoint (passes no `--workers` to uvicorn — single process in prod, relevant to in-process background tasks like the train-reminder ticker)
- Deploys exclusively via `bin/deploy.sh` (never direct SSH)

---

*Stack analysis: 2026-09-02*
