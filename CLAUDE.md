# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Scoped rules live next to the code** and load automatically when you work there:
- `frontend/CLAUDE.md` — React/TypeScript rules (styling, testids, Umami, frontend Sentry)
- `stories/CLAUDE.md` — public data stories at stories.flawchess.com (`stories/`)

**Reference docs** (read on demand, not preloaded):
- `docs/production-runbook.md` — prod server commands, Postgres tuning values, infra notes
- `docs/git-workflow.md` — release promotion, hotfix flow, changelog/milestone-close checklist
- `docs/dev-tooling.md` — script inventory, DB MCP servers, dev clock

## Project

FlawChess — a free, open-source chess analysis platform at flawchess.com. Tagline: "Engines are flawless, humans play FlawChess."

Users import their games from chess.com and/or lichess and analyze win/draw/loss (WDL) rates by board position using Zobrist hashes. This solves inconsistent opening categorization on existing platforms: instead of named openings, FlawChess matches positions exactly. The product covers openings, endgames, time management, tactics, and spaced-repetition training.

Full feature list: see `README.md`.

## Tech Stack

- **Backend**: FastAPI 0.115.x, Python 3.13, uv, Uvicorn
- **Frontend**: React 19 + TypeScript + Vite 8, react-chessboard 5.x, chess.js, TanStack Query, Tailwind CSS
- **Database**: PostgreSQL (asyncpg). No SQLite.
- **ORM**: SQLAlchemy 2.x async (`select()` API, not legacy 1.x) + Alembic + asyncpg
- **Auth**: FastAPI-Users
- **HTTP client**: httpx async only — never use `requests` or `berserk`
- **Chess logic**: python-chess 1.11.x
- **LLM**: pydantic-ai (Anthropic + Google providers) for narrated insights
- **Validation**: Pydantic v2 throughout

## Commands

```bash
# Dev database (PostgreSQL 18 in Docker — required before running backend or tests)
docker compose -f docker-compose.dev.yml -p flawchess-dev up -d

# Backend
uv sync                                   # Install dependencies from lockfile
uv run uvicorn app.main:app --reload      # Dev server
uv run pytest -n auto                     # FULL suite — always use -n auto locally (~2x faster)
uv run pytest tests/test_foo.py::test_bar # Single test (serial; -n auto is pointless for one test)
uv run ruff check . / uv run ruff format .
uv run ty check app/ tests/ scripts/                    # Type check, zero errors required
uv run --project analysis --with ty ty check analysis/  # analysis/ has its own venv
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "description"

# Frontend
npm install / npm run dev / npm run build / npm run lint / npm test

# CI/CD
gh run list
gh run view <run-id> --log-failed
gh run watch <run-id> --exit-status   # `gh pr checks --watch` exits 0 even on failures
```

**Test isolation**: each pytest session clones its own PostgreSQL database from a migrated template that auto-refreshes when the Alembic head changes, so parallel runs are fully isolated and no manual template rebuild is needed after a migration (see `tests/conftest.py`). CI keeps serial execution (D-02); `-n auto` is a local-only convenience.

### Pre-merge gate (MANDATORY before squash-merging to `main`)

Run all of these and resolve every output before integrating work into `main`. This is the safety net that replaces pre-merge CI.

```bash
uv run ruff format app/ tests/ scripts/ analysis/  # apply formatting (not just --check)
uv run ruff check . --fix                          # apply autofixable lint
uv run ty check app/ tests/ scripts/
uv run --project analysis --with ty ty check analysis/
uv run pytest -n auto -x                           # full backend suite, stop on first failure
( cd frontend && npm run lint && npm test -- --run )
```

If any step modifies files, commit with a `style(...)`/`chore(...)` prefix. A CI formatter diff is always avoidable locally since the formatter is deterministic.

## Scripts & tooling

Full inventory in `docs/dev-tooling.md`. The rules that matter without looking:

- **`bin/deploy.sh` is the only sanctioned deploy path.** Never deploy by direct SSH.
- **`bin/reset_db.sh` destroys the dev DB — DO NOT RUN WITHOUT EXPLICIT PERMISSION FROM THE USER.**
- **`scripts/gen_*.py`** regenerate committed `frontend/src/generated/*` files. CI fails on drift, so re-run after editing a source registry.
- Three query-only PostgreSQL MCP servers exist: `flawchess-db` (dev), `flawchess-prod-db` (needs `bin/prod_db_tunnel.sh`), `flawchess-benchmark-db` (needs `bin/benchmark_db.sh start`).
- Time-dependent endpoints must take `now_utc` from the `dev_now_utc` dependency (`app/core/dev_clock.py`), never `datetime.now()` inline.

## Architecture

### Backend layout

```
routers/          # HTTP layer only — no business logic
services/         # Business logic (import, analysis)
repositories/     # DB access (no SQL in services)
```

**Router convention** — always `APIRouter(prefix="/resource", tags=["resource"])` with relative paths in decorators. Never embed the resource prefix in individual route paths:

```python
router = APIRouter(prefix="/openings", tags=["openings"])
@router.post("/positions", ...)   # CORRECT — not "/openings/positions"
```

**Shared query filters** — `app/repositories/query_utils.py` contains `apply_game_filters()`, the single implementation for time control, platform, rated, opponent type, recency, and color filtering. All repositories import from there. Never duplicate filter logic in individual repositories.

### Database design rules

- **Foreign key constraints are mandatory.** Every column referencing another table's primary key must use `ForeignKey()` with an explicit `ondelete` policy (typically `CASCADE` for user-owned data). Never use bare integer columns as implicit references.
- **Unique constraints for natural keys** — add a `UniqueConstraint` for any business-level uniqueness, e.g. one import job per user+platform, one game per user+platform+platform_game_id.
- **Use appropriate column types** — don't use BIGINT where SmallInteger suffices.
- **Avoid native PostgreSQL `ENUM`** (evolving it is awkward and Alembic ignores enum changes). Pick by row count: high-cardinality tables (`game_positions`, `game_flaws`) use `SMALLINT` backed by a Python `IntEnum` + `CHECK (col IN (...))`; low-volume domain columns (status, platform, TC bucket) use `TEXT` + `CHECK`, or a lookup table + FK if the value carries metadata. Align existing columns with this when you touch them.

### Import pipeline

Background async tasks (not blocking the API). chess.com fetches monthly archives sequentially with rate-limit delays. lichess streams NDJSON line-by-line. Both normalize to a unified schema before storage.

## Version Control

**GitLab Flow** (adopted 2026-05-16): `main` is the integration trunk, the long-lived `production` branch is exactly what is deployed. Details, hotfix flow, and the changelog/milestone-close checklist: `docs/git-workflow.md`.

- **`main`** — feature/phase work branches off `main` and merges back via **local squash-merge** (`git merge --squash <branch>`, then delete the branch), not a GitHub PR; the round-trip is too slow. `main` may contain unreleased work; pushing to `main` never deploys.
- **The full pre-merge gate runs once, right before each squash-merge that integrates real work.** A subset run is not acceptable at that point. It is NOT a per-commit tax: incremental feature-branch commits and small direct `main` commits run only the relevant tests (or none for trivial no-logic changes).
- **`production`** — tracks the exact commit in prod. Never commit directly to it; only merges from `main` or `hotfix/*`. Every release goes `main → production` via PR, then `bin/deploy.sh` (or the `/deploy` skill).
- **Changelog is not optional.** Append user-facing bullets under `## [Unreleased]` in `CHANGELOG.md` when a phase merges to `main`; never cut a release without a matching entry.

## Project Management

This project is managed with [Open GSD](https://github.com/open-gsd). All work is planned through GSD phases and roadmap. Do not add unplanned features, refactors, or improvements outside the current phase scope. If something seems needed but isn't in the plan, flag it rather than implementing it.

## User Context

- Data scientist, 20 years web dev experience, Python expert, proficient with FastAPI
- Not a frontend specialist but comfortable with React

## Communication Style

- **No sycophancy** — never open with hollow praise ("Great question!"). Get straight to substance.
- **Challenge ideas constructively** — if an instruction or approach has flaws, trade-offs, or better alternatives, say so directly with reasoning. Don't just agree and execute.
- **Flag over-engineering and scope creep** — push back when a request adds unnecessary complexity or drifts from the goal.
- **Be honest about uncertainty** — say "I'm not sure" or "this might not work because…" rather than presenting guesses as facts.
- **Disagree and commit** — after raising concerns, respect the user's final call and execute fully.
- **Use em-dashes sparingly** in prose, chat, commits, PRs, and UI copy — they read as an AI tell. Prefer commas, periods, parentheses, or colons; one per paragraph is plenty. Not a hard rule for code comments or existing files.

## Coding Guidelines

Apply to both stacks. Frontend-only rules: `frontend/CLAUDE.md`.

- **No magic numbers** — extract thresholds, limits, and config values into named constants: `const MIN_GAMES_FOR_COLOR = 10`, not a bare `10` in a conditional.
- **Type safety** — leverage TypeScript's type system and Python type hints fully. Avoid `any`; give explicit types for function signatures, props, and return values. Prefer discriminated unions over loose string types. **Never use bare `str` for a fixed set of values** — use `Literal["a", "b", "c"]` in Pydantic schemas, function signatures, and return types, in both schemas and service/repository parameters.
- **ty compliance** — all backend code must pass `uv run ty check app/ tests/ scripts/` with zero errors; ty runs in CI between ruff and pytest and blocks the build.
  - Add explicit return type annotations on all functions.
  - Use `Sequence[str]` (not `list[str]`) for parameters accepting `list[Literal[...]]` values — list is invariant, Sequence is covariant.
  - Pydantic models at system boundaries (external API input/output), TypedDicts for internal structured data (filter params, accumulators). See `app/schemas/normalization.py` and `app/services/stats_service.py`.
  - Suppress with `# ty: ignore[rule-name]` (not `# type: ignore`) only where unfixable (SQLAlchemy forward refs, FastAPI-Users generics). Always include the rule name and a brief reason.
- **Comment bug fixes** — add a comment at the fix site explaining what broke and why, so future readers don't have to dig through git history.
- **Keep functions small and shallow.** The strongest signals are nesting depth and branching density; raw LOC is a cheap proxy.
  - **Nesting depth**: soft 3, hard 4 inside any function body. This is the firm rule.
  - **Logic LOC**: soft 100, hard 200 — counting *logic* lines only, excluding the returned JSX tree, large literal config objects (Recharts axis/gradient configs, lookup tables), docstrings, and blanks. A component with a 30-line hook body and a 200-line declarative JSX return is fine; 200 lines of `if/else` data shaping before the return is not.
  - **Cognitive complexity**: aim for ≤15 per function. Many one-line branches can still be too complex at low LOC.
  - Past these limits, split before continuing. Common seams: pipeline orchestrators → one function per stage (`_fetch`/`_classify`/`_rank`); React components → extract data shaping into a `useXyzData` hook, split desktop/mobile renderers past ~40 LOC of logic each; routers stay thin, with branching and aggregation pushed into the service layer; nested loops → invert with early `continue`/`return` or a `Counter` accumulator.
  - **Don't split just to fit a signature.** A context dataclass with <3 fields and one reader, or a "handlers" hook bundling unrelated callbacks by shared deps, is over-engineering. If your split needs a context object to thread state between helpers that always run together, the original was cohesive — leave it or split along a different seam.
- **Refactor bloated code on sight** — when editing a file, if a function already breaches the limits above, refactor it as part of the task rather than adding to it. Exceptions: don't refactor outside a GSD phase plan without flagging it; for `/gsd-quick`/`/gsd-fast` work, prefer a follow-up note over an unscoped refactor. Splitting typically grows file LOC by 20–50% (named helpers, signatures, dataclasses) — only worth paying when each piece is independently readable. When in doubt, surface the bloat and ask.

## Error Handling & Sentry (backend)

Sentry is initialized in `app/main.py`. Dashboard: https://flawchess.sentry.io (org/project `flawchess`, ID `4511084868272208`, region de.sentry.io). Frontend rules: `frontend/CLAUDE.md`.

- **Always call `sentry_sdk.capture_exception()`** in every non-trivial `except` block in `app/services/` and `app/routers/`. Logging alone does NOT reach Sentry.
- **Skip trivial/expected exceptions** — `ValueError` from parsing user input (e.g. time control strings), `UserAlreadyExists` from FastAPI-Users, and similar expected conditions are not bugs.
- **Retry loops: capture on the last attempt only** — for chess.com/lichess API retries, don't capture each transient failure. Let the final exception propagate to the top-level handler, which captures it once.
- **Never embed variables in error messages** — this fragments Sentry grouping. Pass variable data via `set_context()` / `set_tag()`:
  ```python
  # WRONG — each job_id creates a separate Sentry issue
  raise RuntimeError(f"Import failed for job {job_id}")

  # RIGHT — preserves grouping
  sentry_sdk.set_context("import", {"job_id": job_id, "user_id": user_id})
  sentry_sdk.capture_exception(exc)
  ```
- **Tags for filterable dimensions** — `source` (import/api/auth), `platform` (chess.com/lichess). `set_context` for structured data (job_id, game_id, user_id).

## Critical Constraints

- **Never use `asyncio.gather` on the same `AsyncSession`** — SQLAlchemy's `AsyncSession` is not safe for concurrent use from multiple coroutines. A single session uses one DB connection, so gather provides no concurrency benefit anyway. Execute queries sequentially within the same session.
- Always use `httpx.AsyncClient` for external HTTP calls — `requests` blocks the event loop.
- lichess `since`/`until` parameters use millisecond timestamps, not seconds.
- Only import `Standard` variant games — filter out Chess960, crazyhouse, etc.
- Time control bucketing: <180s = bullet, <600s = blitz, <=1800s = rapid, else classical (based on estimated game duration).
- PGN parsing: wrap per-game in try/except, handle `UnicodeDecodeError`, loop `read_game()` until `None` for multi-game strings.
- Use `board.board_fen()` (piece placement only), not `board.fen()` (includes castling/en passant), when comparing positions.
- chess.com requires a `User-Agent` header; fetch archives sequentially with 100-300ms delays.
- API responses never expose internal hashes — return FEN for display.
