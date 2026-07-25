---
phase: quick-260725-da3
plan: 01
subsystem: eval-pipeline
tags: [telemetry, sentry, stockfish, worker-fleet, flawchess-8b]
status: complete
requires: []
provides:
  - worker_heartbeats.holes_submitted / plies_leased (per-worker hole rate)
  - timeout-does-not-restart contract on EnginePool._acquire_and_analyse
  - worker_id/last_ip on the Path-C capacity Sentry event
affects:
  - app/services/engine.py
  - app/routers/eval_remote.py
  - app/services/eval_apply.py
tech-stack:
  added: []
  patterns:
    - accumulating BigInteger counters via on_conflict_do_update (existing submit_count shape)
    - functools.partial to bind lane-specific identity onto a shared callback
key-files:
  created:
    - alembic/versions/20260725_074929_dbf963851fe0_add_worker_hole_counters.py
  modified:
    - app/models/worker_heartbeat.py
    - app/repositories/worker_heartbeat_repository.py
    - app/services/eval_apply.py
    - app/services/engine.py
    - app/routers/eval_remote.py
    - tests/test_worker_heartbeats.py
    - tests/services/test_engine_nodes.py
    - tests/test_eval_worker_endpoints.py
    - CHANGELOG.md
decisions:
  - ITEM 2 SHIPPED — cancellation safety verified at source level and against the real binary
  - counters fed only from apply_full_eval's existing record_heartbeat block (no second upsert)
  - Path-C worker identity bound via functools.partial, shared callback signature unchanged
metrics:
  duration: ~55 min
  completed: 2026-07-25
---

# Quick Task 260725-da3: FLAWCHESS-8B Worker Hole Telemetry + No Engine Restart on Timeout Summary

All three items shipped. Per-worker hole counters make "is it one slow worker?" answerable from the DB, the Stockfish restart-on-timeout amplifier is removed, and the Path-C Sentry event now carries worker identity without changing its grouping string.

## ITEM 2 gate outcome: **SHIP**

### STEP A1 — python-chess 1.11.2 source citations

Read at `.venv/lib/python3.13/site-packages/chess/engine.py`:

| Location | What it does |
|---|---|
| `Protocol.analyse` L1127-1132 | `analysis = await self.analysis(...)`, then `with analysis: await analysis.wait()`. The cancellation lands inside the `with`. |
| `AnalysisResult.__exit__` L2836 | calls `self.stop()`. |
| `AnalysisResult.stop` L2761-2765 | invokes the `_stop` hook installed at `UciAnalysisCommand.start` L1712 (`stop=lambda: self.cancel()`). |
| `UciAnalysisCommand.cancel` L1766-1767 | `self.engine.send_line("stop")` — the engine is told to stop, not abandoned. |
| `UciAnalysisCommand._bestmove` L1758-1763 | on the resulting `bestmove`: `set_finished()` then `analysis.set_finished(best)`. |
| `BaseCommand.set_finished` L1268-1274 | resolves the command's `finished` future and dispatches its callbacks. |
| `Protocol.communicate` L986-1021 | a new command is parked as `next_command` and only `_start()`s from `previous_command_finished` (L1001-1012), i.e. **after** the previous command's `finished` future resolves. |

**Conclusion recorded:** yes — the next `analyse()` on the same slot is serialized behind the stale `bestmove`. The protocol is not abandoned mid-search and the next command cannot interleave with it. `cancel_if_cancelled` (L1006-1010) covers the other branch, where the result future itself is cancelled.

### STEP A2 — empirical probe against the real binary

Permanent test: `tests/services/test_engine_nodes.py::TestEvaluateNodesRealEngine::test_protocol_reusable_after_cancelled_analyse`. Warm up, cancel a 1M-node search at 50 ms via `asyncio.wait_for`, then reuse the **same** protocol object with no restart.

```
1 passed in 3.54s
```

Additional throwaway stress run (12 cycles on one protocol, cancellation instants swept from 1 ms to 101 ms) — every cycle returned a real score afterwards:

```
cycle 0: cancel@0.001s -> reuse score=PovScore(Cp(+7), WHITE) ok=True
...
cycle 11: cancel@0.101s -> reuse score=PovScore(Cp(+31), WHITE) ok=True
```

### One caveat found and measured (does not block)

Cancelling the **very first** analysis on a fresh protocol — the only one that sends `ucinewgame`/`isready`, so `UciAnalysisCommand.result` is resolved asynchronously from the `readyok` handler — makes `_readyok`'s unguarded `self.result.set_result(...)` (L1753) raise `asyncio.InvalidStateError` inside `Protocol.pipe_data_received`. asyncio logs it to the loop exception handler; it does not reach the caller.

Probed at 7 cancellation instants from 0.5 ms to 50 ms: **the protocol remained reusable in all 7** (`reuse ok score=PovScore(Cp(+24), WHITE)` etc.). It self-heals because `_bestmove` still reaches `set_finished()` from the `CANCELLING` state, which releases the queued next command.

Why it does not block shipping: after the first analysis, `first_game` is False and `game` is unchanged (we never pass `game=`), so `_readyok()` runs **synchronously** inside `start()` and the window closes entirely. Reaching it requires a timeout landing within a few ms of a slot's first-ever analyse, against `_NODES_TIMEOUT_S = 5.0`. This window is also not new — it exists identically today.

**Decision: SHIP.**

## What shipped

**ITEM 1 — per-worker hole counters.** `worker_heartbeats.holes_submitted` / `plies_leased`, both `BigInteger NOT NULL` with a permanent `server_default '0'` (migration `dbf963851fe0`, `alembic check` reports no new upgrade operations). Accumulated in the existing `on_conflict_do_update` alongside `submit_count`/`evals_submitted`. Fed from the single `if record_heartbeat:` block in `apply_full_eval` (`n_holes=failed_ply_count`, `n_plies_leased=heartbeat_n_evals`) — inside the caller's one write session, no second upsert. The repository defaults of `0` keep the entry-submit and flaw-blob-submit lanes from inflating the rate. Counted on **every** attempt (Path A/B/C alike), not just the cap.

**ITEM 2 — no restart on timeout.** `_acquire_and_analyse`'s single except tuple split: `asyncio.TimeoutError` returns `None` and keeps the worker (the slot still returns via the existing `finally`); `EngineError`/`EngineTerminatedError` still restart. Four stale docstrings corrected (module header, `evaluate`, `EnginePool` class, `_restart_worker`, `_acquire_and_analyse`).

**ITEM 3 — worker identity on the Path-C event.** `worker_id` added as a Sentry tag plus `worker_id`/`last_ip` in the existing `eval` context. Bound with `functools.partial` at the `_apply_atomic_submit` call site; `apply_completion_decision`'s shared `on_path_c_capacity_reached: Callable[[int, int, int, str], None]` signature is unchanged and `ty` accepts the partial (no `# ty: ignore` needed). `app/services/eval_drain.py` is byte-identical to HEAD. The message string is unchanged and is now asserted `== _PATH_C_CAP_MESSAGE`, a module-level literal.

## Mutation-proof matrix

Every row was proven by applying the mutation, observing the named test fail, then reverting and confirming green.

| Item | Mutation | Test | Observed failure |
|---|---|---|---|
| 1 | `n_holes=0` in `apply_full_eval` | `test_worker_hole_counters_accumulate_across_atomic_submits` | `AssertionError: a Path-B holed submit must count its hole, got 0` / `assert 0 == 1` |
| 1 | `n_plies_leased=0` | same test (and the three-lane test) | `AssertionError: plies_leased must count the submitted plies, got 0` / `assert 0 == 7` |
| 2 | re-merge `asyncio.TimeoutError` into the EngineError except tuple | `test_evaluate_nodes_timeout_returns_none_without_restart` | `AssertionError: 260725-da3: a timeout must NOT restart the worker ...` / `assert not True` |
| 3 | replace the `worker_id=` partial binding with a placeholder | `test_atomic_submit_holed_batch_at_cap_stamps_with_sentry_warning` | `AssertionError: a filterable worker_id Sentry tag must be set at the cap event, got tags [('source', 'remote_eval_worker'), ('worker_id', 'MUTANT')]` |
| 3 | make `eval_drain._log_path_c_capacity_reached` fire `sentry_sdk.capture_message` | `test_cap_reached_stamps_and_logs` | `AssertionError: Cap path must NOT capture to Sentry (demoted to log), got ['full_eval_drain: stamping complete after MAX_EVAL_ATTEMPTS with residual holes']` |

**Note on row 5 (worth recording).** The first attempt at this mutation used the message `"MUTANT drain cap event"` and the test **passed** — a false "the guard is weak" signal. The guard filters `capture_message` calls with `if "MAX_EVAL_ATTEMPTS" in m`, so an arbitrary string slips through. Re-running with a realistic regression (the drain's own `MAX_EVAL_ATTEMPTS` wording) tripped it correctly. The guard is sound for the regression it targets; a mutation has to be realistic to test it.

Also proven along the way: the new counters do **not** move on the entry-submit or flaw-blob-submit lanes — the pre-existing three-lane test now asserts `holes_submitted == 0` and `plies_leased == len(atomic evals)` after all three lanes have run, and it failed under the `n_plies_leased=0` mutation.

## Pre-merge gate

```
uv run ruff format app/ tests/     -> 1 file reformatted, 315 unchanged (committed as style(260725-da3))
uv run ruff check app/ tests/ --fix -> All checks passed!
uv run ty check app/ tests/         -> Found 3 diagnostics  (see below)
uv run pytest -n auto -x            -> 3626 passed, 21 skipped, 7 warnings in 47.09s
```

**`ty`: 3 diagnostics, all pre-existing and environment-only.** All three are `unresolved-import` in `app/services/maia_engine.py` (L46, L103, L153) for `onnxruntime` / `numpy`, which live in the optional `maia-inference` dependency group. That group is not synced in this local venv; CI installs it (`.github/workflows/ci.yml:48`, `uv sync --locked --group maia-inference`), so CI resolves them. `maia_engine.py` is not among the files this task touched (`git diff HEAD~4..HEAD --name-only`), so no diagnostic is attributable to this work. Reporting it rather than claiming a clean zero.

## Commits

| Commit | Scope |
|---|---|
| `384d0fea` | `feat(260725-da3): per-worker hole counters on worker_heartbeats` |
| `7e3aec18` | `fix(260725-da3): do not restart Stockfish on analyse timeout` |
| `3568111a` | `feat(260725-da3): worker identity on the Path-C capacity Sentry event` |
| `12d2d76d` | `style(260725-da3): ruff format the new heartbeat counter test` |

## Deviations from Plan

**1. [Rule 2 — missing critical test signal] Extended the pre-existing three-lane heartbeat test with lane-purity assertions**

- **Found during:** Task 1
- **Issue:** the plan only required the new accumulation test. Nothing would have caught a future change that let the entry-submit or flaw-blob-submit lane feed the counters, which would silently corrupt the hole rate's denominator — the exact "routed everywhere but the input is wrong" half-invariant shape.
- **Fix:** added `holes_submitted == 0` and `plies_leased == len(atomic evals)` assertions to `test_worker_heartbeat_accumulates_across_all_three_submit_lanes`.
- **Files modified:** `tests/test_worker_heartbeats.py`
- **Commit:** `384d0fea`

**2. [Rule 3 — blocking] `_DEFAULT_CLIENT_ADDR` did not exist in `tests/test_eval_worker_endpoints.py`**

- **Found during:** Task 3
- **Issue:** the plan referenced `_DEFAULT_CLIENT_ADDR[0]`-style access for the `last_ip` assertion, but that constant lives in `tests/test_worker_heartbeats.py`, not in the Path-C test's own module.
- **Fix:** defined `_DEFAULT_CLIENT_ADDR`, `_PATH_C_CAP_MESSAGE`, and `_PATH_C_WORKER_ID` as module-level constants next to that module's `_make_client` (CLAUDE.md: no magic numbers / literals).
- **Files modified:** `tests/test_eval_worker_endpoints.py`
- **Commit:** `3568111a`

**3. Docstring prose corrections beyond the two the plan named**

- **Found during:** Task 2 B3
- **Issue:** the plan named `_acquire_and_analyse` L485 and `_restart_worker` L440. A sweep found two more stale claims: the module header ("On engine timeout / crash, evaluate() restarts the affected worker") and `evaluate()`'s docstring ("the affected worker is restarted before returning"), plus the `EnginePool` class docstring ("On per-worker timeout / crash, that worker restarts in place").
- **Fix:** corrected all five.
- **Commit:** `7e3aec18`

## Out of scope / observed but not touched

- Four unrelated frontend files (`frontend/src/assets/personas/grinder-{1000,1400,1600}.webp`, `frontend/src/data/personaAvatarPrompts.md`) appeared as uncommitted working-tree modifications during this session. Not part of this task, left uncommitted and untouched per the scope boundary.
- The reduced-node-budget retry for a timed-out position stays deferred (brief: explicitly out of scope until ITEM 1's data exists).
- `_NODES_TIMEOUT_S`, `_NODES_BUDGET`, `MAX_EVAL_ATTEMPTS`, the Path A/B/C tree, `scripts/resweep_holed_games.py` and `scripts/remote_eval_worker.py`: untouched.
- Not deployed. The user runs `/deploy` separately. Note that ITEM 1's counters only accumulate from the moment the migration is live — the existing ~120 prod rows start at 0, so a per-worker hole rate needs a few hours of fleet traffic before it is readable.

## Known Stubs

None.

## Self-Check: PASSED

- `alembic/versions/20260725_074929_dbf963851fe0_add_worker_hole_counters.py` — FOUND
- `.planning/quick/260725-da3-flawchess-8b-worker-hole-telemetry-no-en/260725-da3-SUMMARY.md` — FOUND
- commits `384d0fea`, `7e3aec18`, `3568111a`, `12d2d76d` — all FOUND in `git log`
- `app/services/eval_drain.py` — confirmed byte-identical to HEAD (`git diff` empty)
