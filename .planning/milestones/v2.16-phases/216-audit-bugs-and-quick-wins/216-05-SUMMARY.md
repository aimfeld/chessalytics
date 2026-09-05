---
phase: 216-audit-bugs-and-quick-wins
plan: 05
subsystem: api
tags: [fastapi, sqlalchemy, health-check, deploy-gate, sentry]

# Dependency graph
requires: []
provides:
  - "GET /api/health that actually round-trips Postgres instead of returning a static 200"
  - "_HEALTH_DB_TIMEOUT_S named constant guarding the health-check query"
affects: [deploy, ci]

# Actuals (#2632)
actuals:
  tokens: 1400
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Health-check handlers must wrap the DB call itself in try/except, not rely on a raising dependency override — FastAPI resolves Depends() generators before the handler body runs, so a dependency-level raise bypasses the handler's own exception handling"

key-files:
  created:
    - tests/test_health.py
  modified:
    - app/main.py

key-decisions:
  - "Handler catches `Exception` only (not a tuple with TimeoutError), since asyncio.wait_for's TimeoutError on Python 3.13 is the builtin Exception subclass and CancelledError (BaseException) must keep propagating — matches CLAUDE.md/ruff redundant-clause guidance."
  - "503 body is the fixed literal {\"status\": \"degraded\"} with no exception detail; failure detail goes to Sentry via capture_exception, never into the HTTP response (T-216-03)."
  - "No alembic-head check added — deploy/entrypoint.sh already runs alembic upgrade head before uvicorn starts, so a migrating container fails the health probe naturally."

requirements-completed: []

coverage:
  - id: D1
    description: "GET /api/health performs a real SELECT 1 against Postgres and returns 200 {\"status\": \"ok\"} when the DB answers, unchanged body shape from before this plan"
    verification:
      - kind: unit
        ref: "tests/test_health.py#test_health_check_returns_ok_when_db_reachable"
        status: pass
    human_judgment: false
  - id: D2
    description: "GET /api/health returns 503 {\"status\": \"degraded\"} with no DB error detail when the query raises or exceeds _HEALTH_DB_TIMEOUT_S, and Sentry captures the exception"
    verification:
      - kind: unit
        ref: "tests/test_health.py#test_health_check_returns_degraded_when_dependency_raises"
        status: pass
      - kind: unit
        ref: "tests/test_health.py#test_health_check_returns_degraded_on_timeout"
        status: pass
    human_judgment: false
  - id: D3
    description: "The deploy loop's curl -sf contract is unchanged, so a 503 now fails the loop instead of passing it"
    verification:
      - kind: other
        ref: "grep -c 'curl -sf https://flawchess.com/api/health' .github/workflows/ci.yml == 1"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-09-04
status: complete
---

# Phase 216 Plan 05: Real database round-trip for /api/health Summary

**`/api/health` now runs `SELECT 1` through a real session on every call, under a named 2-second timeout, and answers a detail-free 503 on any failure — closing F-12 / SEED-161 group 5 where the deploy health loop was blindly trusting a hardcoded 200.**

## Performance

- **Duration:** 25 min
- **Tasks:** 3 completed
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- `health_check` gains an `Annotated[AsyncSession, Depends(get_async_session)]` dependency and awaits `session.execute(text("SELECT 1"))` inside `asyncio.wait_for(..., timeout=_HEALTH_DB_TIMEOUT_S)`, a new module-level `2.0` constant with a comment naming what it protects.
- Success path returns the byte-identical `{"status": "ok"}` body (now via `JSONResponse` for a consistent `-> Response` return type).
- Failure path (`except Exception`) calls `sentry_sdk.capture_exception(exc)` and returns a fixed `503 {"status": "degraded"}` body with zero database/driver detail leaked to the client.
- `tests/test_health.py` (new) proves all three paths: DB reachable (real per-run test Postgres via the existing autouse override), a query that raises, and a query that exceeds the timeout (monkeypatched to 0.05s so the test runs in well under a second).
- Confirmed (not assumed) that `.github/workflows/ci.yml`'s deploy "Health check" loop uses `curl -sf`, which exits non-zero on the new 503 — a degraded backend now fails the release instead of passing it.
- Ran the full backend pre-merge gate: ruff format/check, `ty check`, and the full suite (4502 passed / 19 skipped).

## Task Commits

1. **Task 1: One real request, HTTP to Postgres and back** - `737b2712b` (feat)
2. **Task 2: The two failure paths — dependency raises, and query times out** - `94ab88889` (test)
3. **Task 3: Confirm the deploy contract and run the backend gate** - `8e5fbf83f` (style)

_Note: Task 1's implementation already included the full `try`/`except Exception` handler body (the whole function was natural to write in one pass), so Task 2's commit is test-only — see Deviations below._

## Files Created/Modified
- `app/main.py` - `health_check` now takes a session dependency, runs `SELECT 1` under `_HEALTH_DB_TIMEOUT_S`, returns 503 on failure/timeout
- `tests/test_health.py` - new file, 3 tests covering happy path, query-raises, and timeout

## Decisions Made
- Catch `Exception` only, not a `(TimeoutError, Exception)` tuple — Python 3.13's `asyncio.wait_for` raises the builtin `TimeoutError`, which is already an `Exception` subclass, so a tuple clause is redundant (ruff flags it) and `BaseException`/`CancelledError` must keep propagating.
- 503 body is the fixed literal `{"status": "degraded"}`; no alembic-head probe added (the migration already runs before uvicorn starts per `deploy/entrypoint.sh`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] "Dependency raises" test design didn't match FastAPI's dependency-resolution order**
- **Found during:** Task 2
- **Issue:** The plan's Task 2 action described making the `get_async_session` override itself raise before yielding. FastAPI resolves `Depends()` generator dependencies (entering them up to `yield`) *before* the handler body executes, so a raise there escapes the handler's `try`/`except` entirely and surfaces as an unhandled 500, not the intended 503. Verified directly: the first test attempt failed with an uncaught `RuntimeError` propagating through the ASGI stack.
- **Fix:** Changed the override to yield a stub session object whose `execute()` method raises, mirroring the timeout test's shape. This raises inside the exact `session.execute(...)` call the handler's `try` block wraps, correctly exercising the 503 path.
- **Files modified:** `tests/test_health.py`
- **Verification:** `uv run pytest tests/test_health.py -x -q` — 3 passed.
- **Committed in:** `94ab88889` (part of task commit)

**2. [Task-split note, not a rule] Task 1's commit already contained the full try/except handler body**
- **Found during:** Task 1
- **Issue:** The plan splits the handler across Task 1 (happy path only, no exception handling) and Task 2 (adds `try`/`except` + failure tests). Writing the handler function once, complete, was more natural than leaving it in a half-finished state between commits.
- **Fix:** No functional issue — Task 1's acceptance criteria (200 response, named constant, `ty check` clean) were unaffected by the handler already having its `except Exception` clause. Task 2's commit is test-only as a result.
- **Impact:** None on correctness; slightly different commit boundaries than the plan's literal task split.

---

**Total deviations:** 1 auto-fixed (Rule 1 — test design bug), 1 task-split note (no rule, no code impact).
**Impact on plan:** Both fixes were necessary for the tests to actually prove what they claim to prove. No scope creep — no files touched beyond `app/main.py` and `tests/test_health.py`.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Self-Check: PASSED

- `app/main.py` — FOUND (modified, health_check present with `_HEALTH_DB_TIMEOUT_S`)
- `tests/test_health.py` — FOUND (3 tests, all passing)
- Commit `737b2712b` — FOUND in `git log --oneline`
- Commit `94ab88889` — FOUND in `git log --oneline`
- Commit `8e5fbf83f` — FOUND in `git log --oneline`
- All task `<acceptance_criteria>` re-verified: PASS (200 happy path, 503 exact-body failure/timeout tests, `ty check` clean, `ruff check`/`ruff format --check` clean, full suite 4502 passed/19 skipped, deploy loop's `curl -sf` probe unchanged at count 1)
- Plan-level `<verification>` re-run: `uv run pytest tests/test_health.py -x` → 3 passed in ~6s wall time (per-test `call` durations all <0.1s, satisfying the "timeout test proves fast" intent); `tests/test_last_activity_middleware.py` and `tests/test_sentry_traces_sampler.py` pass unmodified (`git diff --stat` shows no change to either); `ty check` and `ruff check .` clean; `uv run pytest -n auto -x` green (4502 passed / 19 skipped); deploy loop's `curl -sf` probe unchanged.

## Next Phase Readiness
This plan is self-contained (`depends_on: []`, wave 1). No blockers for other 216-* plans. The deploy loop change in behavior (503 now fails the health check instead of the old hardcoded 200) takes effect on the next `/deploy` — no separate action needed.

---
*Phase: 216-audit-bugs-and-quick-wins*
*Completed: 2026-09-04*
