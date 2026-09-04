---
phase: 212-benchmark-full-game-analysis-lane
plan: 03
subsystem: infra
tags: [httpx, worker-fleet, dual-url-fallback, eval-pipeline]

# Dependency graph
requires:
  - phase: 212-01
    provides: "benchmark_selection table + BENCHMARK_SELECTION_GATE_ENABLED gate (context only -- this plan does not touch either)"
provides:
  - "_CycleOutcome(did_work, should_stop) return shape on _run_cycle, separating 'did any rung do work' from 'should the loop stop'"
  - "_BackendTarget / _build_backend_targets -- an ordered list of backend targets, prod always at index 0"
  - "--fallback-url / --fallback-token CLI flags on scripts/remote_eval_worker.py"
  - "run_worker(targets=...) constructing one httpx.AsyncClient per target inside an AsyncExitStack"
  - "_run_loop(clients=...) iterating targets per cycle with strict per-claim prod priority, whole-ladder fallback, single idle-sleep invariant preserved"
affects: [212-06-classical-tranche-run]

# Actuals (#2632)
actuals:
  tokens: 10357
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "contextlib.AsyncExitStack for N independently-constructed httpx.AsyncClient instances, replacing a single `async with httpx.AsyncClient(...) as client:` block"
    - "keyword-only sleep_when_idle flag threaded through a shared per-target ladder function so a multi-target loop preserves a single-sleep-per-idle-cycle invariant"

key-files:
  modified:
    - scripts/remote_eval_worker.py
    - tests/test_remote_eval_worker.py

key-decisions:
  - "should_stop is only checked once the whole cycle is known to be finished (did_work or is_last), not immediately after each target's return -- checking it right after the FIRST target's return would make a --once run stop before ever trying a later target, silently defeating the fallback"
  - "A transient exception (D-14) on a non-last target advances to the next target UNCONDITIONALLY, even when not looping (--once) -- there is more work left to try before a bounded run can conclude. The last (or only) target's transient exception keeps the pre-D-13 --once terminal shape exactly: capture + raise, no streak bookkeeping, matching today's single-target worker byte-for-byte"
  - "A non-transient exception (genuine defect) never falls through to another target regardless of position -- a real bug must not be silently masked by trying the next backend"
  - "sleep_when_idle=True is passed only for the last target in the list so the T-146-06 single-sleep-per-idle-cycle invariant holds regardless of target count; the all-204 tail's own asyncio.sleep call is the ONLY place a fully-idle cycle sleeps"

requirements-completed: [BENCHLANE-03]

coverage:
  - id: D1
    description: "_run_cycle returns _CycleOutcome(did_work, should_stop), separating 'did any rung do work' from 'should the loop stop' at every return point"
    requirement: BENCHLANE-03
    verification:
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_ladder_all_queues_empty_sleeps_once"
        status: pass
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_ladder_bestmove_lease_only_after_flaw_blob_204"
        status: pass
    human_judgment: false
  - id: D2
    description: "A worker configured with --fallback-url drains prod at strict per-claim priority and only tries the fallback after prod's whole five-rung ladder returns 204 in the same cycle -- never per-rung, never interleaved"
    requirement: BENCHLANE-03
    verification:
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_fallback_not_called_when_primary_rung1_works"
        status: pass
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_fallback_not_called_when_primary_rung5_works"
        status: pass
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_fallback_fires_only_after_all_204"
        status: pass
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_ladder_never_interleaves_targets"
        status: pass
    human_judgment: false
  - id: D3
    description: "With --fallback-url omitted, the worker's HTTP call sequence and idle-sleep behavior are byte-identical to before this change"
    requirement: BENCHLANE-03
    verification:
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_single_target_call_sequence_unchanged"
        status: pass
    human_judgment: false
  - id: D4
    description: "An unreachable primary (transient exception) falls through to the fallback in the same cycle rather than idling; a sustained outage still escalates exactly one Sentry event via the existing streak tracking"
    requirement: BENCHLANE-03
    verification:
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_unreachable_primary_falls_through"
        status: pass
    human_judgment: false
  - id: D5
    description: "Both targets fully idle sleeps exactly once per cycle (T-146-06 regression guard extended to N targets)"
    requirement: BENCHLANE-03
    verification:
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_both_targets_idle_sleeps_once"
        status: pass
    human_judgment: false
  - id: D6
    description: "CLI validation: --fallback-url must not be empty/whitespace-only; --fallback-token requires --fallback-url; --fallback-token defaults to the primary token when omitted; --help lists both new flags without printing token values"
    requirement: BENCHLANE-03
    verification:
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_fallback_url_empty_string_rejected"
        status: pass
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_fallback_url_whitespace_only_rejected"
        status: pass
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_fallback_token_without_url_rejected"
        status: pass
      - kind: unit
        ref: "tests/test_remote_eval_worker.py::test_fallback_token_defaults_to_primary_token"
        status: pass
      - kind: other
        ref: "uv run python scripts/remote_eval_worker.py --help (manual run this session)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-08-22
status: complete
---

# Phase 212 Plan 03: Dual-URL Worker Fallback Summary

**Ordered backend targets on `scripts/remote_eval_worker.py`: `_CycleOutcome(did_work, should_stop)` return shape plus `--fallback-url`/`--fallback-token` CLI flags give a worker strict per-claim prod priority with whole-ladder fallback to a second backend, never interleaving rungs across targets.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-22T14:07:43Z (approx, base commit)
- **Completed:** 2026-08-22T14:24:32Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- `_CycleOutcome` frozen dataclass (`did_work`, `should_stop`) replaces the bare `bool` `_run_cycle` and its four `_handle_*_response` helpers used to return. Every return point threaded through; `_run_loop` unpacks `outcome.should_stop` instead of a bare `stop` variable.
- `_BackendTarget` (`base_url`, `token`, `label`) and `_build_backend_targets(base_url, token, fallback_url, fallback_token)` build an ordered target list, prod always at index 0; a single target when `fallback_url` is `None` reproduces today's exact worker.
- `run_worker` now takes `targets: list[_BackendTarget]` and constructs one `httpx.AsyncClient` per target inside a `contextlib.AsyncExitStack` (never mutates `.base_url`, never reuses one client for two URLs).
- `_run_loop` iterates the target list per cycle: tries `clients[0]`'s whole five-rung ladder first, only advances to the next client when `did_work=False`, and once any client does work, later clients are untouched that cycle. A new keyword-only `sleep_when_idle` parameter on `_run_cycle` (passed `True` only for the last target) keeps the T-146-06 single-sleep-per-idle-cycle invariant regardless of target count.
- D-14 unreachable-primary fallthrough: a transient exception (`_is_expected_transient`) on a non-last target advances to the next target unconditionally, even in `--once` mode; the last target's transient failure keeps the pre-existing `--once`/loop terminal semantics exactly (capture+raise when `not loop`, one Sentry-streak-eligible backoff sleep when looping). A non-transient exception never falls through to another target, on whichever target it's raised.
- `--fallback-url` / `--fallback-token` CLI flags added with post-parse validation (`parser.error` on empty/whitespace `--fallback-url`, or `--fallback-token` without `--fallback-url`); the fallback token defaults to the primary's resolved token when omitted, documented in the flag help text. Neither token is ever logged or shown in `--help`.
- 14 new tests added covering the full behavior matrix: single-target byte-identity, fallback-not-called-on-rung-1/-rung-5 success, fallback-fires-only-after-all-204, never-interleaves (cross-mock call-order assertion), both-targets-idle-sleeps-once, unreachable-primary-falls-through, and CLI validation (empty URL, whitespace URL, token-without-url, token defaulting).
- Two mutation checks run and reverted this session (per `feedback_mutation_test_gap_closures`) to confirm the `did_work`/`sleep_when_idle` acceptance criteria are load-bearing, not just present: flipping the all-204 tail's `did_work=False` to `True` failed both `test_ladder_all_queues_empty_sleeps_once` and `test_both_targets_idle_sleeps_once`; removing the `is_last` gate on `sleep_when_idle` made `test_both_targets_idle_sleeps_once` observe 2 sleeps instead of 1. Both mutations reverted via `git checkout --`.

## Task Commits

1. **Task 1: Change `_run_cycle`'s return shape to distinguish "did work" from "should stop"** - `2956309ef` (refactor)
2. **Task 2: Ordered backend targets with whole-ladder fallback (D-13, D-14)** - `686bf3e52` (feat)

## Files Created/Modified

- `scripts/remote_eval_worker.py` - `_CycleOutcome`, `_BackendTarget`, `_build_backend_targets`, `run_worker(targets=...)`, `_run_loop(clients=...)`, `_run_cycle(..., sleep_when_idle=...)`, `--fallback-url`/`--fallback-token` CLI flags + validation
- `tests/test_remote_eval_worker.py` - `did_work` assertions added to 6 existing ladder tests; 14 new tests for the dual-URL fallback behavior matrix and CLI validation

## Decisions Made

- `should_stop` is checked only once the cycle is known finished (`did_work or is_last`), never immediately after a target's return -- otherwise a `--once` run would stop right after the primary's all-204 without ever trying the fallback.
- D-14's transient fallthrough is unconditional on a non-last target (runs even when `not loop`), but the last/only target's transient failure reproduces the exact pre-D-13 single-target `--once` terminal behavior (immediate capture+raise, no streak bookkeeping since the process is about to exit) -- this is what keeps the single-target path byte-for-byte unchanged while still letting `--once` exercise the fallback when one is configured.
- Non-transient exceptions never fall through to another target, regardless of position -- a genuine bug must not be silently masked by trying the next backend.
- `sleep_when_idle=True` only for the last target in the list; the sleep itself still lives entirely inside `_run_cycle`'s existing all-204 tail (no separate sleep call added to `_run_loop`), so there is exactly one code path that can ever call `asyncio.sleep(idle_sleep)` for a fully-idle cycle.

## Deviations from Plan

None - plan executed exactly as written. One design refinement was needed during implementation (documented above under Decisions Made): the plan's action text described the target-advancement and idle-sleep mechanics at a level that left the exact interaction between `should_stop` and multi-target advancement, and between `not loop` and D-14's transient fallthrough, underspecified. Both were resolved by tracing through the single-target-must-stay-byte-identical constraint and the plan's own `<behavior>` bullets to their logical conclusion (see Decisions Made) -- this is implementation detail within Task 2's own scope, not a scope change.

## Issues Encountered

During test authoring, an initial draft of `_run_loop`'s `should_stop` check placement and the D-14 exception-fallthrough logic would have caused an infinite loop / silently skipped the fallback in `--once` mode. Caught before committing by tracing through each named test's expected call sequence against the draft implementation; fixed by moving the `should_stop` check to fire only when the cycle is actually finished, and by making transient-exception fallthrough on a non-last target unconditional on `loop`. No test was ever committed against the buggy draft.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for 212-06 (classical tranche run), which is the consumer of this dual-URL worker patch: a fleet worker pointed at prod with `--fallback-url` set to the local :8001 benchmark backend will drain prod at full priority and only pick up benchmark-lane work when prod's whole ladder is idle, per D-13/D-14.

No blockers. `scripts/remote_eval_worker.py` and `tests/test_remote_eval_worker.py` were the only files this plan owned in the parallel wave (212-02's `app/services/eval_queue_service.py`, `app/main.py`, `tests/services/test_eval_queue.py`, `tests/test_main_lifespan.py` were untouched, per the worktree isolation contract).

## Known Stubs

None.

## Threat Flags

None new. This plan's own threat register (T-212-04, T-212-07, T-212-08, T-212-09) was addressed by design: `--fallback-token` resolved after parse exactly like `--token` (never an argparse default, never logged); the default-to-primary-token behavior for `--fallback-token` is documented in help text, not accidental; whole-ladder `did_work`-gated fallback is pinned by `test_fallback_not_called_when_primary_rung1_works`, `test_fallback_not_called_when_primary_rung5_works`, `test_fallback_fires_only_after_all_204`, and `test_ladder_never_interleaves_targets`; the D-14 accepted-risk scenario (worker loses route to prod but keeps LAN reachability) is unchanged and still surfaced via the existing `TRANSIENT_FAILURE_ALERT_S` streak escalation.

## Self-Check: PASSED

- `scripts/remote_eval_worker.py` - FOUND
- `tests/test_remote_eval_worker.py` - FOUND
- Commit `2956309ef` - FOUND in `git log`
- Commit `686bf3e52` - FOUND in `git log`
- `uv run pytest tests/test_remote_eval_worker.py -x` - 88 passed
- `uv run pytest tests/test_remote_eval_worker.py -k "fallback or unreachable_primary or interleave" -x` - 12 passed (>= 7 required)
- `uv run ruff check scripts/ tests/` - All checks passed
- `uv run ruff format app/ tests/ scripts/` - 434 files left unchanged (no drift)
- `uv run ty check app/ tests/` - All checks passed
- `uv run python scripts/remote_eval_worker.py --help` - exits 0, lists `--fallback-url` and `--fallback-token`, no token values printed
- `uv run python scripts/remote_eval_worker.py --fallback-url "" --once` - exits non-zero (2), error names `--fallback-url`

---
*Phase: 212-benchmark-full-game-analysis-lane*
*Completed: 2026-08-22*
