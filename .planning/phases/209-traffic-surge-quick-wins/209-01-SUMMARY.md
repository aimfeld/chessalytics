---
phase: 209-traffic-surge-quick-wins
plan: 01
subsystem: backend-surge-hardening
tags: [asyncio, concurrency, argon2, semaphore, mutation-testing]
dependency-graph:
  requires: []
  provides:
    - "promote_guest_with_password hashes off the event loop"
    - "compute_stage_a/compute_stage_b concurrency gate (PERCENTILE_COMPUTE_LIMIT)"
  affects:
    - "app/services/guest_service.py"
    - "app/services/user_benchmark_percentiles_service.py"
tech-stack:
  added: []
  patterns:
    - "asyncio.to_thread for the one CPU-bound argon2 hash call"
    - "lazy module-level asyncio.Semaphore mirroring app/core/rate_limiters.py, but placed in the owning service module rather than rate_limiters.py to keep SURGE-06 byte-identity trivially true"
key-files:
  created:
    - tests/services/test_percentile_compute_gate.py
  modified:
    - app/services/guest_service.py
    - tests/test_guest_auth.py
    - app/services/user_benchmark_percentiles_service.py
decisions:
  - "Concurrency test for two-different-guests promotion (SURGE-02) uses two independent DB sessions (own async_sessionmaker over test_engine) run via asyncio.gather, never the same AsyncSession — required by CLAUDE.md's 'never asyncio.gather on the same AsyncSession' rule; the plan's suggested single-db_session approach would have violated it."
  - "Percentile-gate peak-concurrency tests use a fake session_maker whose __aenter__ blocks on an asyncio.Event and increments a shared tracker; verification uses bounded cooperative-yield polling (asyncio.sleep(0) loop with an iteration cap), never wall-clock sleeps, per CLAUDE.md's known-flake-source guidance."
metrics:
  duration: "~45 min"
  completed: "2026-08-10"
status: complete
actuals:
  tokens: 7817
  tasks: 2
  commits: 2
---

# Phase 209 Plan 01: Guest-Promotion Thread Offload & Percentile Compute Gate Summary

Moved the one argon2 hash call in guest-promotion off the event loop and put a
concurrency semaphore around the 1,111.7ms per-import-completion percentile
compute — both proven by reverting the change and watching a named test go red.

## What Was Built

**Task 1 (SURGE-02):** `promote_guest_with_password` in `app/services/guest_service.py`
now awaits `asyncio.to_thread(_password_helper.hash, password)` instead of calling
the argon2id hash synchronously on the event loop. `create_guest_user` (zero-hashing
guest creation path) and `app/users.py` (register/login) are untouched — confirmed by
`git diff app/users.py` being empty and `hashed_password=""` still present in
`create_guest_user`. Three new tests added to the existing `TestPromoteGuestWithPassword`
class in `tests/test_guest_auth.py`:

- `test_promotion_hashes_off_the_event_loop_thread` — spies on `_password_helper.hash`
  via monkeypatch, records `threading.get_ident()`, asserts it differs from the test's
  own thread. This is the SURGE-07 ledger row-2 mutation-proof test.
- `test_second_promotion_of_the_same_user_raises` — idempotency edge case: promoting
  an already-promoted user still raises `ValueError('Not a guest user')`.
- `test_concurrent_promotions_of_two_guests_produce_distinct_hashes` — two different
  guests promoted concurrently via `asyncio.gather` (each through its own independent
  session, per CLAUDE.md's ban on `asyncio.gather` over a shared `AsyncSession`) produce
  distinct, verifying hashes using the real hasher (no monkeypatch) — proves the
  algorithm was not swapped.

**Task 2 (SURGE-05, D-06):** `app/services/user_benchmark_percentiles_service.py` gained
`PERCENTILE_COMPUTE_LIMIT = 2`, a module-level lazy `_percentile_semaphore`, and
`get_percentile_semaphore()` mirroring `app/core/rate_limiters.py`'s shape. The semaphore
is acquired via `async with get_percentile_semaphore():` wrapping the existing
try/except in both `compute_stage_a` and `compute_stage_b` (outside the try, so Sentry
capture semantics are unchanged). Because the semaphore lives inside the function bodies
rather than at either `asyncio.create_task` call site, it covers both of
`compute_stage_b`'s independent trigger sites (`import_service.py`'s completion path and
`eval_drain.py`'s cold-drain zero-pending crossing) by construction — neither file was
touched (`git diff` empty for both). `app/core/rate_limiters.py` remains byte-identical
(md5 `b1b39c57ec38c9819639297cac04d392`).

New test module `tests/services/test_percentile_compute_gate.py` with three tests:

- `test_stage_a_never_exceeds_the_configured_concurrency` — launches
  `PERCENTILE_COMPUTE_LIMIT + 2` concurrent `compute_stage_a` calls against a fake
  session_maker whose `__aenter__` blocks on an unset `asyncio.Event` and tracks peak
  concurrency; asserts peak never exceeds the limit. This is the SURGE-07 ledger row-4
  mutation-proof test.
- `test_stage_b_shares_the_same_semaphore_as_stage_a` — mixes `compute_stage_a` and
  `compute_stage_b` calls through the same blocking session_maker; asserts the combined
  peak never exceeds the limit — proves the eval-drain trigger site is covered.
- `test_semaphore_getter_is_lazy_and_returns_one_shared_instance` — two calls to
  `get_percentile_semaphore()` return the same object at the configured limit.

## Mutation Proofs (SURGE-07)

**Ledger row 2** — reverted the `asyncio.to_thread(...)` wrap in
`promote_guest_with_password` back to a direct synchronous
`_password_helper.hash(password)` call. Re-ran
`test_promotion_hashes_off_the_event_loop_thread`:

```
AssertionError: hash ran on the event-loop thread — asyncio.to_thread wrap is missing/reverted
assert 135191863068480 != 135191863068480
```

Restored the wrapper; all 8 `TestPromoteGuestWithPassword` tests pass again.

**Ledger row 4** — removed the `async with get_percentile_semaphore():` wrapper from
`compute_stage_a` (dedented the body back to its pre-phase shape). Re-ran
`test_stage_a_never_exceeds_the_configured_concurrency`:

```
AssertionError: condition not met after yielding to the event loop repeatedly
```

The test's cooperative-yield wait loop times out because, without the semaphore, all 4
launched tasks (`PERCENTILE_COMPUTE_LIMIT + 2`) enter the blocking session concurrently
instead of the expected 2 — confirmed by an isolated repro script showing
`tracker.current == 4, tracker.peak == 4` (both above `PERCENTILE_COMPUTE_LIMIT = 2`).
Restored the wrapper; all 3 `test_percentile_compute_gate.py` tests pass again, and
`grep -c 'get_percentile_semaphore()' app/services/user_benchmark_percentiles_service.py`
returns `3` (one definition + two acquisitions).

## Verification

- `uv run pytest tests/test_guest_auth.py tests/services/test_percentile_compute_gate.py -x -q` — 29 passed.
- `uv run ruff format app/ tests/` and `uv run ruff check app/ tests/ --fix` — no changes needed after this plan's edits were formatted.
- `uv run ty check app/ tests/` — 3 pre-existing diagnostics unrelated to this plan (see below), zero new errors.
- `md5sum app/core/rate_limiters.py` — `b1b39c57ec38c9819639297cac04d392`, unchanged (SURGE-06).
- `git diff app/users.py app/services/eval_drain.py app/services/import_service.py` — all empty.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/CLAUDE.md compliance] Concurrency test rewritten to avoid `asyncio.gather` on a shared `AsyncSession`**
- **Found during:** Task 1, writing `test_concurrent_promotions_of_two_guests_produce_distinct_hashes`.
- **Issue:** The plan's behavior spec and RESEARCH.md's example code implicitly suggested
  running two `promote_guest_with_password` calls through the same `db_session` fixture
  via `asyncio.gather`. CLAUDE.md's Critical Constraints explicitly forbid
  `asyncio.gather` on the same `AsyncSession` (not thread/coroutine-safe, and provides no
  real concurrency benefit since a session uses one DB connection).
- **Fix:** Rewrote the test to build two independent sessions (own `async_sessionmaker`
  over the `test_engine` fixture, following the existing pattern in
  `tests/routers/test_train.py::test_concurrent_compose_yields_one_open_session`), each
  creating and promoting its own guest, run concurrently via `asyncio.gather` over the
  two independent coroutines (not over calls sharing one session).
- **Files modified:** tests/test_guest_auth.py
- **Commit:** 202032bed

### Pre-existing, out-of-scope issues (not fixed — scope boundary)

- `uv run ty check app/ tests/` reports 3 diagnostics in `app/services/maia_engine.py`
  (unresolved `onnxruntime` / `numpy` imports at lines 46/103/153). Confirmed pre-existing
  via `git stash` + re-run before making any changes — the local `.venv` does not have the
  optional `maia-inference` dependency group installed. Unrelated to this plan's files;
  not touched, per CLAUDE.md's scope-boundary rule ("only auto-fix issues DIRECTLY caused
  by the current task's changes").

## Known Stubs

None.

## Threat Flags

None — this plan's `<threat_model>` (T-209-01-01 through T-209-01-SC) covers the full
surface touched; no new trust boundary or unmitigated threat was introduced beyond what
the plan's threat register already accounts for.

## Self-Check: PASSED

- FOUND: app/services/guest_service.py
- FOUND: app/services/user_benchmark_percentiles_service.py
- FOUND: tests/test_guest_auth.py
- FOUND: tests/services/test_percentile_compute_gate.py
- FOUND commit: 202032bed (feat(209-01): move guest-promotion argon2 hash to worker thread)
- FOUND commit: 3968404e2 (feat(209-01): gate percentile compute behind a concurrency semaphore)
