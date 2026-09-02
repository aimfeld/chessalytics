# Coding Conventions

**Analysis Date:** 2026-09-02

## Naming Patterns

**Backend files (`app/`):**
- `snake_case.py` throughout: `app/services/flaw_delta_zones.py`, `app/repositories/query_utils.py`.
- Layer suffix in the name: `*_service.py` (`admin_service.py`, `endgame_service.py`), `*_repository.py` (`app/repositories/endgame_repository.py`), routers named after the resource (`app/routers/imports.py`, `app/routers/insights.py`) — no `_router.py` suffix.
- Tests mirror the source file: `tests/services/test_canonical_slice_sql.py` for `app/services/canonical_slice_sql.py`, `tests/routers/test_push.py` for `app/routers/push.py`.

**Frontend files (`frontend/src/`):**
- Components: `PascalCase.tsx` (`EndgamesProcessingState.tsx`, `EvalCoverageHeader.tsx`).
- Hooks: `camelCase.ts`/`.tsx` prefixed `use` (`useTrainSession.ts`, `useFlawChessEngine.test.tsx`), living in `frontend/src/hooks/` with a co-located `__tests__/` subfolder for hook tests (`frontend/src/hooks/__tests__/useTrainSession.test.ts`), while non-hook lib tests are co-located next to their source (`frontend/src/lib/materialDiff.test.ts` beside `materialDiff.ts`).
- Directories under `components/` are feature-scoped, not type-scoped: `admin/`, `analysis/`, `auth/`, `board/`, `bots/`, `charts/`, `feedback/`, `filters/`.

**Functions:** `snake_case` in Python (`load_cohort_cells`, `_run_alembic_upgrade`), `camelCase` in TypeScript (`computeMaterialDiff`). Private/internal Python helpers use a leading underscore (`_alembic_head`, `_ensure_template_fresh`, `_maint_dsn`).

**Variables:** `snake_case` in Python, `camelCase` in TS. Module-level constants are `UPPER_SNAKE_CASE` with an explicit type annotation in both languages when it's a typed constant, e.g. `_TEMPLATE_ADVISORY_LOCK_KEY: int = 7_777_777_777` (`tests/conftest.py`), `MIN_GAMES_FOR_CLOCK_STATS` (referenced in `tests/seed_fixtures.py`), `FLAW_DELTA_ZONES: Mapping[str, FlawDeltaZoneSpec]` (`app/services/flaw_delta_zones.py`).

**Types:**
- Python: `PascalCase` dataclasses/Pydantic models (`FlawDeltaZoneSpec`), `Literal[...]` for fixed value sets rather than bare `str` (CLAUDE.md rule — see Type Safety below).
- TypeScript: `PascalCase` for types/interfaces (`TrainPuzzle`, `SolveResponse`), imported with `import type { ... }` when type-only (seen throughout `frontend/src/hooks/__tests__/*.test.ts`).

## Code Style

**Formatting:**
- Backend: `ruff format` (line length 100, set in `pyproject.toml` `[tool.ruff]`). No Black.
- Frontend: **no Prettier** — ESLint is the only formatter/linter (`frontend/eslint.config.js`); do not run `prettier --write` (it will mass-reformat and there is no config to match).

**Linting:**
- Backend: `ruff check .` — per-file ignores for SQLAlchemy forward-ref strings (`app/models/*.py` → `F821`) and Alembic's auto-injected `sa`/`op` imports (`alembic/versions/*.py` → `F401`), both declared in `pyproject.toml` `[tool.ruff.lint.per-file-ignores]`.
- Frontend: flat ESLint config (`frontend/eslint.config.js`) built on `@eslint/js` recommended, `typescript-eslint` recommended, `eslint-plugin-react-hooks` flat recommended, and `eslint-plugin-react-refresh` (Vite). Notable overrides, each with an inline rationale comment in the config:
  - `react-hooks/set-state-in-effect` is globally disabled — codebase intentionally derives state from server data / filters in effects.
  - `react-refresh/only-export-components` is disabled for `src/components/ui/**` (shadcn/ui pattern — components + variant exports), `src/components/filters/**` (filter components co-export `FilterState`, `DEFAULT_FILTERS`, etc.), and `src/components/analysis/**` (overlay exports non-component arrow builders alongside the component).
- Dead-code check: `npm run knip` runs in CI and fails on unused exports/dependencies — when removing a feature, remove its exports too.

## Type Safety (CLAUDE.md rule, verified)

- **`ty` must be zero-error** on `app/ tests/ scripts/` (separately, `analysis/` is checked against its own venv: `uv run --project analysis --with ty ty check analysis/`). Enforced in CI (`.github/workflows/ci.yml`, steps "Type check (ty)" and "Type check (ty, analysis project)").
- `unused-ignore-comment = "warn"` is set in `[tool.ty.rules]` (`pyproject.toml`) so stale `# ty: ignore[...]` comments surface.
- `Sequence[str]` preferred over `list[str]` for parameters accepting `list[Literal[...]]` (list is invariant); see the pattern documented at `app/schemas/normalization.py` and `app/services/stats_service.py` per CLAUDE.md — Pydantic models are reserved for external API boundaries, TypedDicts for internal structured accumulators.
- Frontend `tsconfig` enables `noUncheckedIndexedAccess` — every array/Record index access is `T | undefined`; narrow with a local + `if`, a provably-safe `!`, or `?? fallback`. Never `// @ts-ignore` (per `frontend/CLAUDE.md`).
- `npm run build` (`tsc -b && vite build`) is the real type-check gate for frontend — `npm run lint`/`npm test` do not type-check because esbuild strips types. Run `npm run build` explicitly after changing shared types or property access.

## Import Organization

**Backend (`app/`):** standard-library imports first, blank line, third-party (`fastapi`, `sqlalchemy`, `httpx`, `pytest`), blank line, `app.*` internal imports last — e.g. `tests/routers/test_push.py`:
```python
from __future__ import annotations

import base64
import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
...
from app.core.config import settings as config_settings
from app.main import app
from app.services import train_reminder_service
```
`from __future__ import annotations` appears at the top of files using modern generic syntax under older-compatible runtime checks (e.g. `app/repositories/*.py`, several `tests/*.py`).

**Frontend:** vitest/testing-library imports, then third-party (`react`, `@tanstack/react-query`, `react-router`), then `@/` aliased internal imports, then relative/type-only imports last — see `frontend/src/hooks/__tests__/useTrainSession.test.ts`. Path alias `@` → `frontend/src` is defined in `frontend/vite.config.ts` (`resolve.alias`).

## Error Handling

**Backend — Sentry is mandatory in service/router `except` blocks** (CLAUDE.md, verified in `app/routers/imports.py:138,160`, `app/routers/admin_activity.py:86`): every non-trivial `except` in `app/services/` and `app/routers/` calls `sentry_sdk.capture_exception()` (or `sentry_sdk.capture_exception(exc)` when the exception object is bound). Trivial/expected exceptions (`ValueError` from user-input parsing, `UserAlreadyExists`) are intentionally NOT captured.
- Never interpolate variable data into the exception message (fragments Sentry grouping) — use `sentry_sdk.set_context()` / `set_tag()` instead. See CLAUDE.md example under "Error Handling & Sentry".
- Retry loops (chess.com/lichess fetch retries) capture only on the final failed attempt, not every transient one.
- `HTTPException(status_code=..., detail="...")` is the standard way routers surface client-facing errors — plain string details, no leaked internals: `raise HTTPException(status_code=404, detail="Game not found")` (`app/routers/imports.py:406`).

**Frontend:**
- Global TanStack Query errors are captured once, centrally, in `frontend/src/lib/queryClient.ts` via `QueryCache.onError` / `MutationCache.onError`. Do NOT add a duplicate `Sentry.captureException()` inside a component using `useQuery`/`useMutation`.
- Manual `fetch`/`axios` calls outside TanStack Query (auth forms, direct API calls) must call `Sentry.captureException(error, { tags: { source: '...' } })` in their `catch`.
- Every `useQuery` result rendered through a loading/data/empty ternary chain must include an explicit `isError` branch — never let a fetch failure silently fall through to an empty-state message.

## Comments

- Long, dated rationale comments are the norm for anything non-obvious, especially test infra and hard-won bug fixes — see the extensive header comments in `tests/conftest.py` explaining per-run DB cloning, or the phase/decision references sprinkled through service and test docstrings (`Phase 94.2`, `D-04`, `T-100-01`).
- **Bug-fix comments are required** (CLAUDE.md): a comment at the fix site explains what broke and why, e.g. the `SENTRY_DSN=""` / `SECRET_KEY` overrides at the top of `tests/conftest.py`, or `frontend/src/hooks/useTrainSession.ts`'s cross-device score fix referenced in `useTrainSession.test.ts` ("BUGFIX-TRAIN-SCORE-CROSSDEVICE").
- Module/file docstrings commonly cite the originating GSD phase and decision IDs (`Phase 61`, `D-07`, `CR-01`) so future readers can trace design rationale back to planning docs.

## Function/Module Design (CLAUDE.md, enforced by convention not by a linter rule)

- **Nesting depth**: soft 3, hard 4 inside a function body — the firm rule.
- **Logic LOC**: soft 100, hard 200, excluding JSX returns, large config literals, docstrings, blanks.
- **Cognitive complexity**: aim ≤15 per function.
- Common extraction seams observed in the codebase: pipeline stages split into `_fetch`/`_classify`/`_rank`-style private helpers (e.g. `tests/conftest.py`'s `_ensure_template_fresh` / `_create_run_db` / `_drop_run_db` / `_run_alembic_upgrade`); React data shaping pulled into `useXyzData` hooks; routers stay thin (see `app/routers/imports.py`, `app/routers/insights.py` — branching lives in `app/services/`).
- No magic numbers: named constants throughout, e.g. `_EXPECTED_BREAKPOINTS: int = 99` (`app/repositories/...`), `_TEMPLATE_ADVISORY_LOCK_KEY: int = 7_777_777_777` (`tests/conftest.py`), `_BASE_TIME_SECONDS: dict[str, int]` (`tests/seed_fixtures.py`).
- **Refactor bloated code on sight** when editing a file that already breaches the size/nesting limits, rather than adding to it (CLAUDE.md) — not verified structurally here, but stated as house rule; flag rather than doing an unscoped refactor outside a GSD phase.

## Module Design

**Backend:** three-layer split enforced by convention, not framework: `app/routers/` (HTTP only, no business logic), `app/services/` (business logic), `app/repositories/` (DB access, no SQL in services). Shared query-filter logic lives in one place only — `app/repositories/query_utils.py`'s `apply_game_filters()` — never duplicated per-repository (CLAUDE.md, structural rule).

**Frontend:** components own their exports; shadcn/ui `components/ui/**` and feature `components/filters/**`/`components/analysis/**` intentionally co-export non-component values (types, constants, builder functions) alongside the component, with ESLint's `react-refresh/only-export-components` explicitly disabled for those directories (see Code Style above).

## Data-Story Sub-Project (`stories/`)

`stories/` (public data stories, `stories/CLAUDE.md`) follows different conventions from the app — self-contained HTML pages, inline CSS/JS, no CDNs (except Google Fonts + Umami), and is exempt from GSD phase planning (work happens directly on `study/<slug>` branches, squash-merged to `main`). Not part of `frontend/` or `app/` conventions above.

---

*Convention analysis: 2026-09-02*
