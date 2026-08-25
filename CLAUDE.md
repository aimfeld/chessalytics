# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FlawChess — a free, open-source chess analysis platform at flawchess.com. Tagline: "Engines are flawless, humans play FlawChess."

Users import their games from chess.com and/or lichess and analyze win/draw/loss (WDL) rates by board position using Zobrist hashes. This solves inconsistent opening categorization on existing platforms — instead of named openings, FlawChess matches positions exactly. The product covers openings, endgames, and time management.

### Key Features

- **Game Analysis** — Stockfish analysis of the user's whole game history via remote worker infrastructure; blunder and mistake tagging with statistics, plus tactic detection.
- **Endgame Analytics** — WDL by endgame type (rook, minor piece, pawn, queen, mixed), conversion rates when up material, recovery rates when down, Endgame ELO timeline per (platform, time control), and LLM-narrated personalized feedback.
- **Opening Explorer & Insights** — interactive move explorer with WDL per candidate move; automatic 16-half-move scan surfaces opening strengths/weaknesses with deep-links into the explorer; usable for scouting opponents.
- **Time Management Stats** — average clock advantage/deficit at endgame entry, performance under matching time-pressure levels vs opponents, flag rates per time control.
- **Opening Comparison & Tracking** — bookmark positions, compare WDL trends over time, filter by time control.
- **System Opening Filter** — filter by user's pieces only (white_hash / black_hash) to analyze system openings (e.g. the London) across all opponent variations.
- **Cross-platform import** — combine chess.com and lichess games, filter by color, time control, opponent type, recency.
- **Mobile-first PWA** — installable on iOS/Android, drawer-based filter and bookmark sidebars, click-to-move on touch.

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
uv sync                          # Install dependencies from lockfile
uv run uvicorn app.main:app --reload  # Run dev server
uv run pytest -n auto            # Run the FULL suite — ALWAYS use -n auto locally (parallel, ~2x faster)
uv run pytest tests/test_foo.py::test_bar  # Run a single test (serial — -n auto is pointless for one test)
uv run pytest -n auto -x         # Full suite, stop on first failure
uv run ruff check .             # Lint
uv run ruff format .            # Format
uv run ty check app/ tests/ scripts/     # Type check (must pass with zero errors)
uv run --project analysis --with ty ty check analysis/  # Type check analysis/ (own venv)
uv run alembic upgrade head     # Run migrations
uv run alembic revision --autogenerate -m "description"  # Create migration

# Frontend
npm install                     # Install dependencies
npm run dev                     # Dev server
npm run build                   # Production build
npm run lint                    # Lint
npm test                        # Run frontend tests
npm run test:watch              # Run tests in watch mode

# CI/CD (GitHub Actions)
gh run list                     # List recent workflow runs
gh run view <run-id> --log-failed  # View failed job logs
gh run watch <run-id>           # Watch a run in progress
gh pr checks <pr-number>        # Check PR status ("no checks reported" on a release PR usually means the PR has a merge conflict — see Version Control)
```

### Test isolation (per-run DB)

Each pytest session clones its own PostgreSQL database from a migrated template that
auto-refreshes when the Alembic head changes, so parallel runs are fully isolated. No
manual template rebuild is needed after a migration. See `tests/conftest.py` for details.

**Always run the full backend suite with `-n auto`** (~2x faster, safe given per-run-DB
isolation). Use serial `uv run pytest <nodeid>` only for a single test or small subset. CI
keeps serial execution (D-02) — `-n auto` is a local-only convenience.

### Pre-merge gate (MANDATORY before squash-merging to `main`)

Run all of these and resolve every output before integrating work into `main`. This is the safety net that replaces pre-merge CI (see Version Control).

```bash
uv run ruff format app/ tests/ scripts/ analysis/  # apply formatting (not just --check)
uv run ruff check . --fix    # apply autofixable lint
uv run ty check app/ tests/ scripts/            # type check, zero errors required
uv run --project analysis --with ty ty check analysis/  # same, for the standalone analysis project
uv run pytest -n auto -x               # full backend suite (parallel), stop on first failure
( cd frontend && npm run lint && npm test -- --run )  # frontend lint + tests
```

If any step modifies files, commit with a `style(...)`/`chore(...)` prefix. A CI formatter diff is always avoidable locally since the formatter is deterministic.

Optional one-time hook: `bin/install_pre_push_hook.sh` installs a pre-push hook running `ruff format --check`, `ruff check`, and `ty check` (pytest excluded for speed). Bypass with `git push --no-verify`.

## Scripts

`bin/` holds shell helpers, `scripts/` holds Python maintenance/backfill/benchmark tools. Most are self-describing — read the docstring or run with `--help`. A few have non-obvious behavior worth flagging:

- **`bin/deploy.sh`** — the only sanctioned deploy path (CI → `production`). Never deploy by direct SSH.
- **`bin/reset_db.sh`** — destroys and recreates the dev DB. DO NOT RUN WITHOUT EXPLICIT PERMISSION FROM THE USER.
- **`bin/prod_db_tunnel.sh`** — SSH tunnel forwarding prod PostgreSQL to `localhost:15432` (needed for the prod-db MCP and `--db prod` scripts).
- **`bin/benchmark_db.sh`** — lifecycle (`start`/`stop`/`reset`) for the benchmark Postgres on port 5433.
- **`scripts/gen_*.py`** (e.g. `gen_endgame_zones_ts.py`, `gen_flaw_thresholds_ts.py`) — regenerate committed `frontend/src/generated/*` files from Python sources. CI fails on drift, so re-run after editing the source registry.
- **`scripts/backfill_*.py`** — most take `--db dev|benchmark|prod` and `--user-id`; `--db prod` requires `prod_db_tunnel.sh`.
- **`scripts/reset_train_state.py`** — wipes one user's Train/drill state (items, sessions, solves, streak snapshot) so a schedule test starts clean. Refuses `--db prod`. Pairs with the dev clock below.

### Dev clock (testing Train's schedule without waiting days)

Train's behavior is calendar-shaped (weekday mask, session expiry, due-date ladder, Mon-start streak weeks). `app/core/dev_clock.py` provides a `dev_now_utc` FastAPI dependency that shifts "now" by the `X-Dev-Clock-Offset-Minutes` request header, **honored only when `ENVIRONMENT == "development"`** (inert in every other environment). The Train page renders a time-travel strip in dev builds (`frontend/src/components/train/TrainDevClock.tsx`, gated on `import.meta.env.DEV`) that persists the offset in localStorage; `frontend/src/api/client.ts`'s request interceptor attaches the header.

Rows written while shifted keep the shifted dates, so after travelling forward use `scripts/reset_train_state.py --user-id N` to get back to a clean slate. Any new time-dependent endpoint should take `now_utc` from this dependency rather than calling `datetime.now()` inline.

## Database Access (MCP)

Three PostgreSQL MCP servers are configured for direct database queries:

- **`flawchess-db`** — local dev database (Docker on `localhost:5432`). Requires dev DB running: `docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`
- **`flawchess-prod-db`** — production database via read-only user. Requires SSH tunnel: `bin/prod_db_tunnel.sh` (forwards `localhost:15432` → prod DB on port 5432). Stop with `bin/prod_db_tunnel.sh stop`.
- **`flawchess-benchmark-db`** — benchmark database (Docker on `localhost:5433`). Requires `bin/benchmark_db.sh start`. Read-only role; password is local-only, not committed.

All three are query-only MCP tools (`mcp__flawchess-*-db__query`). Dev uses the app user (read-write at SQL level, but the wrapper is query-only); prod and benchmark use dedicated read-only roles.

## Architecture

### Core Concept: Zobrist Hash Position Matching

The central architectural decision. Positions are matched via precomputed 64-bit integer Zobrist hashes, not FEN string comparison:
- `white_hash` — hash of white pieces only (enables "my pieces only" queries)
- `black_hash` — hash of black pieces only
- `full_hash` — hash of complete position

All three are computed at import time for every half-move and stored in `game_positions`. Position queries become indexed integer equality lookups.

### Backend Layout

```
routers/          # HTTP layer only — no business logic
services/         # Business logic (import, analysis)
repositories/     # DB access (no SQL in services)
```

### Router Convention

All routers use `APIRouter(prefix="/resource", tags=["resource"])` with relative paths in decorators. Never embed the resource prefix in individual route paths:
```python
# CORRECT
router = APIRouter(prefix="/openings", tags=["openings"])
@router.post("/positions", ...)

# WRONG — duplicates prefix in every route
router = APIRouter(tags=["openings"])
@router.post("/openings/positions", ...)
```

### Shared Query Filters

`app/repositories/query_utils.py` contains `apply_game_filters()` — the single implementation for time control, platform, rated, opponent type, recency, and color filtering. All repositories import from here. Never duplicate filter logic in individual repositories.

### Database Design Rules

- **Foreign key constraints are mandatory.** Every column referencing another table's primary key must use `ForeignKey()` with an explicit `ondelete` policy (typically `CASCADE` for user-owned data). Never use bare integer columns as implicit references — PostgreSQL must enforce referential integrity.
- **Unique constraints for natural keys.** Add `UniqueConstraint` for any business-level uniqueness (e.g., one import job per user+platform combo, one game per user+platform+platform_game_id).
- **Use appropriate column types.** E.g. don't use BIGINT where SmallInteger suffices. 
- **Enumerated columns: avoid native PostgreSQL `ENUM`** (evolving it is awkward and Alembic ignores enum changes). Pick by row count: high-cardinality tables (`game_positions`, `game_flaws`) use `SMALLINT` backed by a Python `IntEnum` + `CHECK (col IN (...))`; low-volume domain columns (status, platform, TC bucket) use `TEXT` + `CHECK`, or a lookup table + FK if the value carries metadata. Align existing columns with this when you touch them.

### Import Pipeline

Background async tasks (not blocking the API). chess.com fetches monthly archives sequentially with rate-limit delays. lichess streams NDJSON line-by-line. Both normalize to a unified schema before storage.

## Production Server

The production server is accessible via `ssh flawchess` (configured in user's SSH config). The deploy user is `deploy`, app lives at `/opt/flawchess`.

```bash
# SSH into server
ssh flawchess

# Check services
ssh flawchess "cd /opt/flawchess && docker compose ps"

# View backend logs
ssh flawchess "cd /opt/flawchess && docker compose logs --tail=50 backend"

# Deploy (always use this — runs CI tests, then deploys the `production` branch)
# Promote a release first: PR main → production, then:
bin/deploy.sh

# Restart backend only
ssh flawchess "cd /opt/flawchess && docker compose restart backend"

# Full restart (data persists in named volumes)
ssh flawchess "cd /opt/flawchess && docker compose down && docker compose up -d"
```

- Domain: flawchess.com (Caddy handles auto-TLS)
- Stack: PostgreSQL 18 + FastAPI/Uvicorn + Caddy 2.11.2
- Hetzner Cloud CPX42, 8 vCPUs, 16 GB RAM + 4 GB swap (`/swapfile`), 160 GB NVMe.

**Current prod config (source of truth, not historical).** The repeated 2026 OOM-kills traced to import memory pressure (not Stockfish); the incident-by-incident history lives in git and in the `project_prod_oom_cause` / `project_prod_postgres_wal_and_buffers` memory files. The values that matter now:

- **Postgres tuning lives in `docker-compose.yml` db `command:`** (the single source of truth — not migrations, not `postgresql.auto.conf`): `shared_buffers=2GB`, `effective_cache_size=8GB`, `work_mem=16MB`, `maintenance_work_mem=512MB`, `max_connections=30`, `max_wal_size=8GB`, `wal_compression=on`. Do not raise `shared_buffers` above 2GB — it amplifies checkpoint flush size and revisits the OOM history.
- **`shm_size: "256m"`** on the db service (a Docker option, NOT a Postgres flag): Docker's 64 MB `/dev/shm` default exhausts under parallel-query DSM segments and surfaces as a misleading `asyncpg.DiskFullError`. A bare `docker compose restart db` does NOT apply a changed `shm_size` — recreate the container (`docker compose up -d db` or `bin/deploy.sh`).
- **SQLAlchemy pool** `10 + 10` overflow; backend/db containers have `mem_limit`/`memswap_limit` set (no swap → contained OOM-restart).
- **`STOCKFISH_POOL_SIZE=6`** in prod (stable; ~368 MB/worker → fits the 4g backend container). Raising to 8 is gated on a 24h soak of API latency + container RSS.
- Hetzner Cloud Firewall: inbound TCP 22/80/443 + ICMP from any.
- Alembic migrations run automatically on backend container startup via `deploy/entrypoint.sh`.
- `.env` on server at `/opt/flawchess/.env` — never commit production secrets.
- Docker BuildKit cache capped at 3 GB by a daily cron (`/etc/cron.d/docker-builder-prune`, 3am UTC) — each deploy rebuilds images on the server, so the cache fills the disk without it. Inspect with `docker system df` (containerd image store, not `/var/lib/docker/buildkit`).
- VAPID key rotation (Web Push, only on suspected key compromise): follow `docs/push-vapid-rotation-runbook.md`.

## Version Control

This project uses **GitLab Flow** (adopted 2026-05-16): `main` is the integration trunk, a long-lived `production` branch is exactly what is deployed.

- **`main`** — integration trunk. Feature/phase work branches off `main` and merges back via **local squash-merge** (`git merge --squash <branch>`, then delete the branch), not a GitHub PR — the round-trip is too slow. `main` may contain unreleased work; pushing to `main` never deploys. **The full pre-merge gate (above) runs once, right before each squash-merge that integrates real work** — a subset run is not acceptable at that point. It is NOT a per-commit tax: incremental feature-branch commits and small direct `main` commits run only the relevant tests (or none for trivial no-logic changes). Relies on branch protection with `enforce_admins: false`; if that flips to `true`, revert to the PR route. CodeQL runs post-merge.
- **`production`** — tracks the exact commit in prod, and is the real gate: every release goes `main → production` via PR, and `bin/deploy.sh` re-runs full CI before shipping. Never commit directly to `production` (only merges from `main` or `hotfix/*`). **Gotcha: `gh pr checks` reporting "no checks" on a release PR means it's unmergeable** — usually a missing forward-port of the previous release; fix with `git merge -s ours origin/production` on main, push, and the check starts.
- **Release promotion**: at a milestone boundary (or any approved release point), open a PR `main → production`, then run `bin/deploy.sh`.
- **Hotfix flow** (urgent prod fix without shipping unreleased `main`):
  1. `git checkout -b hotfix/<slug> production`
  2. Apply the minimal fix, PR into `production`, merge when approved.
  3. `bin/deploy.sh` (deploys `production`).
  4. Forward-port: merge `production` back into `main` (or cherry-pick the fix) so the fix isn't lost at the next release. Expect conflicts when `main` has diverged — resolve in favour of the prod-safe value.

## Changelog & Releases

Releases are cut at the **milestone** boundary (not per phase). Changes accumulate in `CHANGELOG.md` under `## [Unreleased]` as phases merge, then get promoted to a versioned section when the milestone ships.

### Per-phase (when a phase merges to `main`)

Append one or more bullets under `## [Unreleased]` in `CHANGELOG.md`, grouped into `### Added` / `### Changed` / `### Fixed` / `### Removed` / `### Security` / `### Tests` subsections. Reference the phase number. Keep the tone terse and user-facing (what changed, not how). Skip this for `/gsd-quick` / `/gsd-fast` tasks that don't meaningfully change behavior (pure refactors, tooling tweaks, internal cleanup).

### Per-milestone (at milestone close)

When a milestone ships (e.g. via `/gsd-complete-milestone`), **always do all of the following — none are optional**:

1. In `CHANGELOG.md`, rename `## [Unreleased]` → `## [vX.Y] Milestone Title — YYYY-MM-DD`, reset `[Unreleased]` to empty, and update the compare links at the bottom.
2. **Archive the milestone's phase directories**: `git mv .planning/phases/<phase-dir> .planning/milestones/vX.Y-phases/` for every phase in the milestone (create `.planning/milestones/vX.Y-phases/` if absent), so `.planning/phases/` holds only the next milestone's active work. This is separate from the milestone-doc archival (`/gsd-complete-milestone` archives MILESTONES/ROADMAP/RETROSPECTIVE/REQUIREMENTS but does NOT move the phase working dirs).
3. Tag and push (`git tag vX.Y && git push origin vX.Y`).
4. **`gh release create vX.Y`** using the `CHANGELOG.md` section as the body — the tag alone is not a release; verify with `gh release list` that vX.Y shows up (a lingering tag with no GitHub release means this step was skipped).

Never cut a release without a matching `CHANGELOG.md` entry. Never edit a released section retroactively — corrections go in a new `[Unreleased]` bullet. Archiving the phase dirs and creating the GitHub release are mandatory milestone-close steps, not just the tag.

## Project Management

This project is managed with [GET SHIT DONE (GSD)](https://github.com/gsd-build/get-shit-done). All features and work are planned through GSD phases and roadmap. Do not add unplanned features, refactors, or improvements outside the current GSD phase scope. If something seems needed but isn't in the plan, flag it rather than implementing it.

### GSD Context Management

- **Discuss → Plan: keep context.** The planner benefits from having the raw discussion available for resolving ambiguities not fully captured in artifacts.
- **Plan → Execute: `/clear` before execution.** The executor reads `PLAN.md` and `RESEARCH.md` from `.planning/` — everything important is already distilled there. Clearing frees context for file reads, test output, and error traces, and improves signal-to-noise ratio.
- **Small tasks (`/gsd:quick`, `/gsd:fast`): don't bother clearing** — the overhead isn't worth it for inline tasks.

### GSD worktree isolation vs. phase branches

Claude Code forks `isolation="worktree"` agent trees from `main`, but the `phase` branching strategy keeps phase branches ahead of `main`. So a worktree executor's base won't match the phase-branch HEAD and the spawn-time branch-check fail-closes with a base mismatch (seen on `/gsd-quick`; applies to `/gsd-phase` waves too). This is expected — **don't disable worktrees over it.** Recovery: the orphaned worktree auto-removes (it never committed), so just re-dispatch the executor **inline** (no `isolation="worktree"`) on the current branch. Worktree isolation still adds value for parallel phase waves, so `workflow.use_worktrees` stays enabled.

### Seeds (`.planning/seeds/`)

Forward-looking ideas captured via `/gsd-capture --seed`, surfaced at `/gsd-new-milestone`.

- **Numbering spans both folders.** Active seeds live in `.planning/seeds/`; completed ones are moved to `.planning/seeds/closed/`. The next ID is `max(SEED-NNN across BOTH folders) + 1` — **never** count-based (the `plant-seed` workflow's `ls | wc -l` default undercounts and collides with closed IDs). Always compute the max over `.planning/seeds/ .planning/seeds/closed/` before assigning a number.
- **Move to `closed/` when done.** When a seed's work is implemented (or it's abandoned), `git mv .planning/seeds/SEED-NNN-*.md .planning/seeds/closed/` so the active folder reflects only open ideas. The ID stays reserved (don't reuse it).

## User Context

- Data scientist, 15 years web dev, Python expert, proficient with FastAPI
- Not a frontend specialist but comfortable with React

## Communication Style

- **No sycophancy** — never open with hollow praise ("Great question!", "That's a great idea!"). Get straight to substance.
- **Challenge ideas constructively** — if an instruction or approach has flaws, trade-offs, or better alternatives, say so directly with reasoning. Don't just agree and execute.
- **Flag over-engineering and scope creep** — push back when a request adds unnecessary complexity or drifts from the goal.
- **Be honest about uncertainty** — say "I'm not sure" or "this might not work because…" rather than presenting guesses as facts.
- **Disagree and commit** — after raising concerns, respect the user's final call and execute fully.
- **Use em-dashes sparingly** in prose, chat, commits, PRs, and UI copy — they read as an AI tell. Prefer commas, periods, parentheses, or colons; one per paragraph is plenty. Not a hard rule for code comments or existing files.

## Coding Guidelines

These apply to both backend and frontend code. For frontend-only rules, see the [Frontend](#frontend) section below.

- **No magic numbers** — extract thresholds, limits, and configuration values into named constants. Example: `const MIN_GAMES_FOR_COLOR = 10` not a bare `10` in a conditional.
- **Type safety** — leverage TypeScript's type system and Python type hints fully. Avoid `any`, prefer explicit types for function signatures, props, and return values. Use discriminated unions over loose string types. On the backend, use Pydantic models for validation and typed dataclasses/TypedDicts where appropriate. Never use bare `str` for fields with a fixed set of values — use `Literal["a", "b", "c"]` in Pydantic schemas, function signatures, and return types. This applies to both schemas and service/repository function parameters.
- **ty compliance** — all backend code must pass `uv run ty check app/ tests/ scripts/` with zero errors. ty runs in CI between ruff and pytest and blocks the build. When writing new code:
  - Add explicit return type annotations on all functions.
  - Use `Sequence[str]` (not `list[str]`) for function parameters that accept `list[Literal[...]]` values — list is invariant, Sequence is covariant.
  - Use Pydantic models at system boundaries (external API input/output) and TypedDicts for internal structured data (filter params, accumulators). See `app/schemas/normalization.py` and `app/services/stats_service.py` for examples.
  - Use `# ty: ignore[rule-name]` (not `# type: ignore`) to suppress errors that can't be fixed (e.g., SQLAlchemy forward refs, FastAPI-Users generics). Always include the rule name and a brief reason.
- **Comment bug fixes** — when fixing a bug, add a comment at the fix site explaining what broke and why. Future readers shouldn't have to dig through git history to understand why non-obvious code exists.
- **Keep functions small and shallow** — the strongest signals are nesting depth and branching density; raw LOC is a cheap proxy. Limits:
  - **Nesting depth**: soft 3, hard 4 inside any function body. This is the firm rule (Linus' "if you need more than 3 levels of indentation, you're screwed" applies in both stacks).
  - **Logic LOC**: soft 100, hard 200. Measure *logic* lines — exclude the returned JSX tree, large literal config objects (Recharts axis/gradient configs, lookup tables), docstrings, and blank lines. A component with a 30-line hook body and a 200-line declarative JSX return is fine; the same component with 200 lines of `if/else` data shaping before the return is not.
  - **Cognitive complexity**: aim for ≤15 per function (SonarQube default). If a function has many branches but each branch is one line, it can still be too complex even at low LOC.
  Past these limits, split before continuing. Common seams: pipeline orchestrators → one function per stage (`_fetch`/`_classify`/`_rank`); React components → extract data shaping into a `useXyzData` hook, split desktop/mobile renderers when each exceeds ~40 LOC of logic; routers → keep thin, push branching/aggregation into the service layer; nested loops → invert with early `continue`/`return` or a `Counter` accumulator. **Don't split just to fit a signature**: a context dataclass with <3 fields and one reader, or a "handlers" hook bundling unrelated callbacks by shared deps, is over-engineering — the original was probably cohesive.
- **Refactor bloated code on sight** — when editing a file, if you encounter a function that already breaches the limits above (deep nesting, high logic LOC, mixes 3+ concerns), refactor it as part of the task rather than adding to it. Exceptions: do not refactor outside the scope of a GSD phase plan without flagging it; for `/gsd-quick`/`/gsd-fast` work, prefer a follow-up note over an unscoped refactor. When in doubt, surface the bloat and ask before expanding scope. Note: splitting a function usually grows total LOC in the file by 20–50% (named helpers, signatures, dataclasses). That cost is only worth paying when each piece is independently readable. If your split requires a context object to thread state between helpers that always run together, the original function was probably cohesive — leave it alone or split along a different seam.

## Error Handling & Sentry

Sentry is initialized in both backend (`app/main.py`) and frontend (`frontend/src/instrument.ts`). Dashboard: https://flawchess.sentry.io (org/project `flawchess`, ID `4511084868272208`, region de.sentry.io).

### Backend Rules

- **Always call `sentry_sdk.capture_exception()`** in every non-trivial `except` block in `app/services/` and `app/routers/`. Do not rely on logging alone — errors logged to DB or console do NOT reach Sentry unless explicitly captured.
- **Skip trivial/expected exceptions** — `ValueError` from parsing user input (e.g. time control strings), `UserAlreadyExists` from FastAPI-Users, and similar expected conditions are not bugs and should not be reported.
- **Retry loops: capture on last attempt only** — for retry patterns (chess.com/lichess API retries), do NOT call `capture_exception` on each transient failure. Let the final exception propagate to the top-level handler which captures it once.
- **Never embed variables in error messages** — this fragments Sentry grouping. Pass variable data via `sentry_sdk.set_context()` or `sentry_sdk.set_tag()`:
  ```python
  # WRONG — fragments grouping (each job_id creates a separate Sentry issue)
  raise RuntimeError(f"Import failed for job {job_id}")

  # RIGHT — preserves grouping, variables as context
  sentry_sdk.set_context("import", {"job_id": job_id, "user_id": user_id})
  sentry_sdk.capture_exception(exc)
  ```
- **Use tags for filterable dimensions** — `source` (import/api/auth), `platform` (chess.com/lichess). Use `set_context` for structured data (job_id, game_id, user_id).

### Frontend Rules

- **Global TanStack Query errors** are already captured in `frontend/src/lib/queryClient.ts` via `QueryCache.onError` and `MutationCache.onError`. Do NOT add duplicate `Sentry.captureException()` in components that use `useQuery`/`useMutation` — the global handler covers them.
- **Manual fetch/axios calls in catch blocks** (auth forms, direct API calls outside TanStack Query) MUST call `Sentry.captureException(error, { tags: { source: '...' } })`.
- **Skip expected failures** — e.g. checking if Google OAuth is available (`.catch(() => setGoogleAvailable(false))`) is expected to fail in dev environments.
- **Always handle `isError` in data-loading ternary chains** — every `useQuery` result rendered with a loading/data/empty chain must include an `isError` branch showing "Failed to load [X]. Something went wrong. Please try again in a moment." Never let errors fall through to empty-state messages like "No games imported yet" — this misleads users into thinking they have no data when the API simply failed.

## Critical Constraints

- **Never use `asyncio.gather` on the same `AsyncSession`** — SQLAlchemy's `AsyncSession` is not safe for concurrent use from multiple coroutines. A single session uses one DB connection, so gather provides no concurrency benefit anyway. Execute queries sequentially within the same session.
- Always use `httpx.AsyncClient` for external HTTP calls — `requests` blocks the event loop
- lichess `since`/`until` parameters use millisecond timestamps, not seconds
- Only import `Standard` variant games — filter out Chess960, crazyhouse, etc.
- Time control bucketing: <180s = bullet, <600s = blitz, <=1800s = rapid, else classical (based on estimated game duration)
- PGN parsing: wrap per-game in try/except, handle `UnicodeDecodeError`, loop `read_game()` until `None` for multi-game strings
- Use `board.board_fen()` (piece placement only) not `board.fen()` (includes castling/en passant) when comparing positions
- chess.com requires `User-Agent` header; fetch archives sequentially with 100-300ms delays
- API responses never expose internal hashes — return FEN for display

## Data Stories

Public data stories (blog-style pages at stories.flawchess.com) live in `stories/`. All story-specific rules (header/branding, publication dates, terminology, chart styling, report co-location) are in `stories/CLAUDE.md` — read it before creating or editing anything under `stories/`.

## Frontend

Rules specific to `frontend/` (React + TypeScript + Vite). Shared cross-stack rules live in [Coding Guidelines](#coding-guidelines).

### Code Style & Safety

- **Theme constants in theme.ts** — all theme-relevant color constants (WDL colors, gauge zone colors, glass overlays, opacity factors) must be defined in `frontend/src/lib/theme.ts` and imported from there. Never hard-code color values that have semantic meaning (win/loss/draw, danger/warning/success, muted states) directly in components.
- **`noUncheckedIndexedAccess` is enabled** — every array/Record index access in TypeScript returns `T | undefined`. You must narrow before use: assign to a local variable and check (`const val = arr[i]; if (val) { ... }`), use `!` non-null assertion when the index is provably in bounds, or use `?? fallback` for Records. Never use `// @ts-ignore` to suppress these errors.
- **Knip runs in CI** — `npm run knip` in the frontend detects dead exports and unused dependencies. CI fails if knip finds issues. When removing a feature, also remove its exports. When adding exports, ensure they're actually imported somewhere.
- **Minimum font size is `text-sm`** — never use `text-xs` (or smaller) in new code. Even for badges, captions, metadata, footnotes, and "supporting" labels — `text-sm` is the floor. Sub-`text-sm` becomes unreadable on real devices and at high DPI. If a row feels too dense at `text-sm`, fix the layout (more whitespace, fewer columns, shorter labels), don't shrink the type. Applies to all Tailwind utilities (`text-xs`, raw `font-size` < 14px, `[font-size:0.75rem]`, etc.) and to UI copy on both desktop and mobile. **Exception: hover/tap-activated info tooltips** (Radix popover bodies with the HelpCircle trigger pattern — `MetricStatPopover`, `WdlConfidenceTooltip`, `EvalConfidenceTooltip`, `AchievableScorePopover`, etc.) may use `text-xs`; these are short, transient, opt-in surfaces where the denser text reads as a visual aside rather than primary content.

### Outbound link tracking (Umami)

Umami does **not** track outbound clicks automatically. Every `<a>` leaving flawchess.com (including `mailto:`) needs an explicit `data-umami-event` attribute, otherwise the click is invisible:

```tsx
<a href={gameUrl} data-umami-event="outbound-platform-game" data-umami-event-platform={game.platform} target="_blank" rel="noopener noreferrer">
```

- **Naming**: `outbound-<destination>`, kebab-case. Reuse the same name for the same destination across pages so totals aggregate (`outbound-github`, `outbound-support-email`).
- **Many low-value links of one kind** (the Home acknowledgements list) share one event name plus a `data-umami-event-<prop>` attribute for the specific target, so the dashboard shows one row with a breakdown instead of a dozen near-zero rows.
- Events land in the **app** Umami site (`0ca19960-…`, tag in `frontend/index.html`), separate from the stories site. Only fires on `flawchess.com` because of `data-domains`, so localhost clicks are never recorded.
- Dynamically rendered links (game cards) work without extra wiring: the tracker observes DOM mutations and binds new elements.
- **Never put `data-umami-event` on an internal react-router `<Link>`.** On an `<a href>` without `target="_blank"` the tracker calls `preventDefault()` and then assigns `location.href` itself, downgrading a client-side navigation into a full page reload. For internal links call `trackEvent()` from `frontend/src/lib/analytics.ts` in `onClick` instead; the attribute is only for `<button>` elements and outbound `target="_blank"` links.
- Track only what the browser knows and the database cannot: signup-CTA attribution (`signup-cta` + `source`), guest starts, and the PWA install funnel. Signups, imports, and analysis runs already live in `users` / `import_jobs` and must not be duplicated as events.

### UI & Components

- **Mobile friendly UI** — use responsive design patterns (Tailwind breakpoints, flexible layouts) so all pages and components work well on small screens.
- **Always apply changes to mobile too** — when modifying a component that has separate desktop and mobile sections (e.g. Openings page sidebar vs mobile drawer layout), apply the same change to both unless the change is desktop-specific by nature (e.g. a desktop-only layout restructuring). Search for duplicated markup before considering a change complete. This includes styling changes (button variants, colors), adding/removing UI elements (info popovers, icons), and behavioral changes.
- **Primary vs secondary buttons** — the look lives in the `Button` variants (`components/ui/button.tsx`); never hand-roll button colors with `className`/`bg-*`. Primary = `variant="default"` (solid brand brown, the single high-emphasis CTA). Secondary = `variant="brand-outline"` (brown outline; Save/Suggest, Reset Filters). Do NOT use `variant="secondary"` for secondary actions — it's reserved for neutral gray chips/toggles. When a user says "secondary button", they mean `brand-outline`.

### Browser Automation Rules

These rules ensure the UI remains compatible with the Claude Chrome extension and other automated testing tools.

**Required on All New Frontend Code:**

1. **`data-testid` on every interactive element** — buttons, links, inputs, select triggers, toggle items, and collapsible triggers. Use kebab-case, component-prefixed format: `data-testid="btn-import"`, `data-testid="nav-bookmarks"`, `data-testid="filter-time-control-bullet"`.

2. **Semantic HTML** — use `<button>` for clickable non-link elements, `<a>` for navigation, `<nav>` for navigation regions, `<main>` for page content, `<form>` for data entry. Never use `<div onClick>` or `<span onClick>`.

3. **ARIA labels on icon-only buttons** — any button without visible text must have `aria-label`. Example: `<Button aria-label="Flip board" data-testid="board-btn-flip">`.

4. **Major layout containers** — page containers, section headings, and modal dialogs must have `data-testid`. Example: `data-testid="dashboard-page"`, `data-testid="import-modal"`.

5. **Chess board** — the board container must have `data-testid="chessboard"` and the `id="chessboard"` option set (generates stable square IDs like `chessboard-square-e4`). Board moves must support both drag-drop and click-to-click (two clicks: source then target).

**Naming Convention:**
- `btn-{action}` — standalone action buttons
- `nav-{page}` — navigation links
- `filter-{name}` — filter controls
- `board-btn-{action}` — board control buttons
- `{component}-{element}-{id?}` — dynamic elements (e.g., `bookmark-card-3`)
- `square-{coord}` — chess squares (e.g., `square-e4`)
