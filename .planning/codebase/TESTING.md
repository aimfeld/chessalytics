# Testing Patterns

**Analysis Date:** 2026-09-02

## Test Frameworks

**Backend:**
- Runner: `pytest` >=8.0.0 with `pytest-asyncio` (auto mode) and `pytest-xdist` for parallelism. Config: `pyproject.toml` `[tool.pytest.ini_options]`.
- `asyncio_mode = "auto"` — no `@pytest.mark.asyncio` needed on async tests.
- `asyncio_default_fixture_loop_scope = "session"` and `asyncio_default_test_loop_scope = "session"` — all async tests/fixtures share one session-scoped event loop.
- Coverage tooling present (`pytest-cov`) but no enforced threshold found in `pyproject.toml`.
- **Slow-test exclusion by directory** (`addopts` in `pyproject.toml`): `--ignore=tests/scripts/benchmarks --ignore=tests/scripts/tagger`. Both are excluded from the default run because they hit the heavy benchmark DB / run hundreds of puzzles through the tactic detector. Run explicitly with a path override: `uv run pytest tests/scripts/benchmarks` or `uv run pytest tests/scripts/tagger`. CI runs the tagger suite as a separate explicit step ("Tagger precision gate": `uv run pytest tests/scripts/tagger -v`), but never runs the benchmarks suite.

**Frontend:**
- Runner: Vitest (`npm test` = `vitest run`, `npm run test:watch` = `vitest`), configured inline inside `frontend/vite.config.ts` (no separate `vitest.config.ts`) — but no `test:` block was found there; Vitest falls back to picking up `jsdom`/`node` per-file via the `// @vitest-environment jsdom` pragma comment used at the top of DOM-touching test files (present in the large majority — 165+ of 250 test files grepped). Files without the pragma run in Vitest's default environment (`node`), appropriate for pure-logic tests like `frontend/src/lib/materialDiff.test.ts`.
- Assertion library: Vitest's built-in `expect` (Chai-compatible) plus `@testing-library/jest-dom`-style matchers via `@testing-library/react`.
- No MSW (Mock Service Worker) in use — API mocking goes through `vi.mock()` directly on the API client module (see Mocking below).
- No standalone `setupFiles`/global test-setup file was found — each DOM test opts in per-file.

**Run Commands:**
```bash
# Backend
uv run pytest -n auto                       # Full suite, parallel (local convenience; CI is serial)
uv run pytest tests/test_foo.py::test_bar   # Single test (serial)
uv run pytest tests/scripts/benchmarks      # Slow benchmark-DB regression suite (excluded by default)
uv run pytest tests/scripts/tagger -v       # Tactic-tagger precision gate (excluded by default, run in CI separately)

# Frontend
npm test              # vitest run (single pass, CI mode)
npm run test:watch    # vitest (watch mode)
```

## Test File Organization

**Backend (`tests/`):**
```
tests/
├── conftest.py           # session-scoped DB isolation fixtures (see below)
├── seed_fixtures.py       # shared seeded_user fixture (registered via pytest_plugins)
├── test_*.py              # flat top-level tests (e.g. test_impersonation.py, test_lichess_client.py)
├── routers/                # HTTP integration tests, one file per router
├── services/                # business-logic unit tests, one file per service module
├── repositories/             # DB-access tests
├── models/                    # ORM model tests
├── schemas/                    # Pydantic schema tests
├── integration/                 # cross-layer integration tests
├── prompts/                      # LLM prompt tests
├── fixtures/                      # static fixture data (maia_parity/, write_path_golden/)
└── scripts/
    ├── benchmarks/                 # heavy benchmark-DB regression tests (--ignore'd by default)
    ├── tagger/                     # tactic-detector precision/recall gate (--ignore'd by default; scores against fixtures/tagger/*.csv, a CC0 lichess puzzle set)
    └── fixtures/
```
Naming: `test_<module_under_test>.py`, mirroring the `app/` module it covers (e.g. `tests/services/test_canonical_slice_sql.py` ↔ `app/services/canonical_slice_sql.py`).

**Frontend (`frontend/src/`):**
- Co-located: `Component.tsx` next to `Component.test.tsx` — e.g. `frontend/src/lib/materialDiff.ts` / `frontend/src/lib/materialDiff.test.ts`.
- Hooks use a `__tests__/` subfolder under `frontend/src/hooks/`: `frontend/src/hooks/__tests__/useTrainSession.test.ts`.
- A few cross-cutting tests live under `frontend/src/__tests__/` (e.g. `pushServiceWorker.test.ts`, `instrument.beforeSend.test.ts`, `noEndgameSkillString.test.tsx`) when they don't belong to one component/module.
- `frontend/src/App.test.tsx` is the app's first nav-level integration test (added Phase 171 Plan 03) — it re-exports `NavHeader`/`MobileBottomBar`/`MobileMoreDrawer`/`MobileHeader` additively from `App.tsx` so they can be rendered directly in isolation, each wrapped in its own `MemoryRouter` + `TooltipProvider`, since a full `<App />` render is impractical (it owns its own `BrowserRouter`/`AuthProvider`/`QueryClientProvider` stack).

## Backend: Per-Session Database Isolation (`tests/conftest.py`)

This is the load-bearing test-infra pattern for the whole backend suite (Phase 100):

- Each pytest session (and each `pytest-xdist` worker) gets its **own** Postgres database, `flawchess_test_<worker|pid>`, created via `CREATE DATABASE ... TEMPLATE flawchess_test_template`. This avoids a whole-schema `ACCESS EXCLUSIVE` lock that a shared-DB wipe-between-tests approach would require, and lets parallel agent runs and `-n auto` workers run fully isolated.
- The template DB auto-refreshes when the live Alembic head differs from the template's stored `alembic_version` row — **no manual template rebuild step is ever needed** after writing a new migration.
- Refresh is serialized cluster-wide via `pg_advisory_lock(_TEMPLATE_ADVISORY_LOCK_KEY=7_777_777_777)`: the first run to acquire the lock does the drop+remigrate; others block, then re-check drift after acquiring and skip if already fresh.
- Killed runs self-heal: `DROP DATABASE IF EXISTS` before every `CREATE DATABASE` reaps stale DBs left behind by a previously killed session.
- DB name resolution priority (`_get_run_db_name()`): `TEST_DB_NAME` env override (validated against `_DB_NAME_RE = ^[a-z_][a-z0-9_]{0,62}$` — DB names can't be parameter-bound in DDL, so this guard exists specifically against SQL-identifier injection) → `PYTEST_XDIST_WORKER` (`gw0`, `gw1`, ...) → `os.getpid()` fallback for serial runs.
- CI (`.github/workflows/ci.yml`) runs the postgres service container with **no** `POSTGRES_DB` set — the suite clones its own DB at runtime via the always-present `postgres` maintenance DB, connecting through `DATABASE_URL_TEST=postgresql+asyncpg://postgres:postgres@localhost:5432/flawchess_test`.
- **CI runs serially** (no `-n auto`); `-n auto` is documented as a "local-only convenience" (CLAUDE.md) — this matters because parallel execution can hide isolation bugs that only surface serially (see project memory: alembic `disable_existing_loggers` caplog gotcha).
- Test setup also disables Sentry (`SENTRY_DSN=""`) and sets a full-length `SECRET_KEY` and `PYDANTIC_AI_MODEL_INSIGHTS="test"` at the very top of `conftest.py`, before any `app.*` import, so app startup code sees them.

## Seeded Fixtures (`tests/seed_fixtures.py`)

`seeded_user` is a **module-scoped** `pytest_asyncio` fixture (registered globally via `pytest_plugins = ["tests.seed_fixtures"]` in `conftest.py` — this avoids the `ruff F811` "redefined unused import" that would occur if test modules imported it by name directly) providing one authoritative test user with a deterministic 25-game portfolio: platforms × time controls × colors × WDL, an endgame-class transition game, one unrated game, plus 10 additional chess.com blitz endgame games with `clock_seconds` populated to cross `MIN_GAMES_FOR_CLOCK_STATS` thresholds. An `EXPECTED` dict of precomputed aggregates is asserted against the spec at module import time, so tests reference expected values by name instead of hand-counting. Registered via HTTP (`httpx` against the FastAPI `app`), not direct ORM inserts, so tests exercise the real registration/import path.

## Mocking

**Backend:**
- `unittest.mock` (`AsyncMock`, `MagicMock`, `patch`) is the standard mocking toolkit — see `tests/routers/test_push.py`.
- Prefer patching the **factory/boundary function**, not the underlying stdlib class, when the test itself also drives an HTTP call through the same class. Example: `tests/routers/test_push.py` patches `app.services.push_send.push_http_client` (the app's own client factory) instead of `httpx.AsyncClient.post` at the class level, because the outer test-driving ASGI request also goes through `httpx.AsyncClient` and would otherwise be intercepted too. A `_FakePushHttpClient` async-context-manager stand-in wraps an injected `AsyncMock` so assertions read naturally (`assert_awaited_once()`, `.await_args`).
- Router integration tests drive the app over real HTTP via `httpx.AsyncClient` + `ASGITransport` against `app.main.app`, following a "register-and-login-over-HTTP" pattern (`tests/routers/test_train.py`, `tests/routers/test_push.py`).
- Byte-identical SQL string assertions are used as a deliberate regression-pin technique for SQL-building helpers, e.g. `tests/services/test_canonical_slice_sql.py` embeds a literal baseline CTE string (`_BASELINE_PER_USER_CTE_MEDIAN_ANCHOR_RAPID_BENCHMARK`) captured at a specific git commit, asserted byte-for-byte — any whitespace/column-order/helper-extraction drift trips the test.

**Frontend:**
- `vi.mock()` mocks whole modules, most commonly the shared API client (`@/api/client`), spreading `actual` and overriding only the specific functions under test:
```typescript
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    trainApi: { ...actual.trainApi, composeOrResumeSession: vi.fn(), solvePuzzle: vi.fn() },
  }
})
```
(`frontend/src/hooks/__tests__/useTrainSession.test.ts`)
- No MSW/network-layer interception — mocking happens at the module boundary (the API client), not at fetch/XHR.
- Hook tests wrap `renderHook` with a fresh `QueryClientProvider`/`QueryClient` per test (TanStack Query), asserting via `waitFor` + `act`.
- Component tests wrap render targets in the providers they need directly — `MemoryRouter`, `TooltipProvider` — rather than a shared custom render helper (no global `test-utils.tsx` render wrapper was found).

## Fixtures and Test Data

**Backend:**
- Static fixture data lives under `tests/fixtures/` (`maia_parity/`, `write_path_golden/`) and `tests/scripts/fixtures/`, `tests/scripts/tagger` scores against `fixtures/tagger/*.csv` (CC0 lichess puzzle dump — see Tagger fixture regen note in project memory: regen is only byte-identical against the exact same source dump).
- Builder-style helper functions construct domain objects with sane defaults + `overrides`, e.g. `tests/seed_fixtures.py`'s per-class endgame defaults (`_CLASS_DEFAULT: dict[int, tuple[str, int]]`) and `_BASE_TIME_SECONDS` lookup dict.

**Frontend:**
- Local `makeX(overrides: Partial<X> = {})` factory functions defined at the top of the test file itself (not a shared factory module) — e.g. `makePuzzle()` in `useTrainSession.test.ts`. No fixture directory equivalent to the backend's `tests/fixtures/` was found; test data is inlined as FEN string constants (`frontend/src/lib/materialDiff.test.ts`) or built via local factory functions.

## Coverage

- `pytest-cov` is installed but no coverage threshold/gate was found enforced in `pyproject.toml` or CI.
- No frontend coverage tool/threshold configured in `frontend/package.json`.

## Test Types

**Backend:**
- Unit tests: pure-function/service-layer logic, no DB (e.g. `app/services/flaw_delta_zones.py` would be tested purely; `tests/services/test_canonical_slice_sql.py` tests SQL-string generation without executing).
- Integration tests: router-level tests hitting the FastAPI app over `httpx.AsyncClient` + `ASGITransport`, using the real (per-run cloned) Postgres DB — `tests/routers/*.py`, `tests/integration/*.py`.
- Real-engine tests exist for the Stockfish wrapper — CI installs a pinned Stockfish binary (`sf_18`) before running pytest specifically for these (`.github/workflows/ci.yml`, "Install Stockfish (for engine wrapper tests)" step). Project memory notes a known flake pattern here: under `-n auto`/SCHED_IDLE the 2s timeout guard can starve — the fix is to patch the timeout constant in the TEST, never the prod constant.

**Frontend:**
- Unit tests: pure logic (`materialDiff.test.ts`, `engineEvalLookup.test.ts`, `flawChessVerdict.test.ts`) run without the jsdom pragma when no DOM is touched.
- Hook tests: `renderHook` + `@testing-library/react`, DOM environment via the `@vitest-environment jsdom` pragma.
- Component/integration tests: `render`/`screen`/`fireEvent`/`within` from `@testing-library/react`, e.g. `App.test.tsx`.
- No E2E framework (Playwright/Cypress) detected — browser-level verification instead relies on the `data-testid` convention (`frontend/CLAUDE.md`, "Browser Automation Rules") for Claude-in-Chrome-driven manual/automated exploration, not a committed E2E suite.

## CI Pipeline (`.github/workflows/ci.yml`)

Runs on PRs to `main`/`production`, single `test` job (Postgres 18-alpine service container), in this order:
1. `uv sync --locked --group maia-inference`
2. Generated-file drift checks (zone/threshold/curve/calibration TS files — regenerate and `git diff --exit-code`)
3. `pip-audit --strict` (with two documented ignored CVEs)
4. `ruff check .`
5. `ruff format --check app/ tests/ scripts/ analysis/`
6. `ty check app/ tests/ scripts/`
7. `ty check analysis/` (separate project env)
8. Install pinned Stockfish binary
9. `uv run pytest` (full suite, serial — respects the `addopts` ignores from `pyproject.toml`)
10. `uv run pytest tests/scripts/tagger -v` (tactic precision gate, explicit — not covered by step 9's default ignores)
11. `npm ci` (frontend deps)
12. `npx audit-ci --config audit-ci.jsonc` (frontend vuln scan, allowlist-based — see `frontend/audit-ci.jsonc`)
13. `npm run lint` (eslint)
14. `npm run build` (`tsc -b && vite build` — the real frontend type-check gate)
15. `npm test` (vitest run)
16. COOP/COEP header + WASM MIME guard (curl checks against `npm run preview`)
17. `npm run knip` (dead-code check)
18. Docker image build + Trivy container vulnerability scan (HIGH/CRITICAL, fails on unfixed)

A separate `deploy` job runs only on `workflow_dispatch` against `production` with `inputs.deploy == true`, after `test` passes — SSH deploy + health check polling `https://flawchess.com/api/health`.

Notable: `tests/scripts/benchmarks` (the heavy benchmark-DB numeric-regression suite) is **not** run in CI at all — it's excluded by `pyproject.toml` `addopts` and has no explicit CI step, unlike the tagger suite. It's a manual/on-demand suite (`uv run pytest tests/scripts/benchmarks`).

## Common Patterns

**Async testing (backend):** `asyncio_mode = "auto"` means async `def test_...()` functions need no decorator; fixtures are async via `pytest_asyncio.fixture`.

**Async testing (frontend):**
```typescript
await waitFor(() => expect(someState).toBe(expected))
```
via `@testing-library/react`'s `waitFor` — project memory flags a known trap here: Vitest's default `testTimeout` (5s) and testing-library's `waitFor` default (1000ms) are two *independent* ceilings; a bare `waitFor` failure hits the 1000ms ceiling regardless of any per-test Vitest timeout override.

**Error-path testing (backend):** router tests assert on `HTTPException` status codes/detail strings returned over real HTTP (e.g. `test_dev_trigger_404_outside_development` in `tests/routers/test_push.py`), not on raised-exception introspection.

---

*Testing analysis: 2026-09-02*
