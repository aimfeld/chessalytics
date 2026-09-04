---
phase: 212-benchmark-full-game-analysis-lane
plan: 02
subsystem: infra
tags: [sqlalchemy, eval-lottery, benchmark-db, postgresql, fail-closed]

# Dependency graph
requires:
  - phase: 212-benchmark-full-game-analysis-lane
    provides: "212-01: benchmark_selection table, _selection_gate_clause() wired into _claim_tier3_derived, byte-identity test pattern"
provides:
  - "_selection_gate_clause() applied to all four lottery predicate sites (_claim_tier3_derived Step 1+2 from 212-01, plus this plan's _claim_tier4_blob Stage 1+2 and _claim_tier4_bestmove Stage 1+2)"
  - "assert_benchmark_selection_gate_ready() fail-closed boot assertion wired into app/main.py's lifespan"
affects: [212-05-tranche-status-and-record, 212-06-classical-tranche-run]

# Actuals (#2632)
actuals:
  tokens: 8325
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fail-closed boot assertion mirroring assert_secret_key_configured() (app/core/config.py): a no-op when the guarded flag is off (no DB session opened), called from the lifespan (not import time) so scripts/ and Alembic are unaffected, raising RuntimeError before start_engine() when the flag is on but its precondition is unmet."

key-files:
  created: []
  modified:
    - app/services/eval_queue_service.py
    - app/main.py
    - tests/services/test_eval_queue.py
    - tests/test_main_lifespan.py

key-decisions:
  - "Gate suffix interpolation at all four new sites mirrors 212-01's byte-identity technique exactly: the (possibly-empty) gate clause is appended directly onto the end of the last predicate line/segment with a conditional leading space, never as its own interpolated line, so the flag-off render stays byte-for-byte identical to the pre-gate baseline."
  - "assert_benchmark_selection_gate_ready() lives in eval_queue_service.py immediately below _selection_gate_clause() (not in app/core/config.py alongside assert_secret_key_configured) because it queries the database via async_session_maker, unlike the pure-settings secret-key check -- keeping it next to the predicate it protects also keeps the DB-touching assertion out of the settings module."
  - "No variable data interpolated into the RuntimeError message (CLAUDE.md Sentry rule) -- the flag name and table name are both constants, so the message is a fixed literal naming benchmark_selection and pointing the operator at scripts/benchmark_lane.py select, with no host/credential ever in the string."

requirements-completed: [BENCHLANE-02]

coverage:
  - id: D1
    description: "All four lottery predicate sites (_claim_tier3_derived Step 1+2 from 212-01, _claim_tier4_blob Stage 1+2, _claim_tier4_bestmove Stage 1+2) honor the gate -- byte-identical to baseline when off, narrows to the selected game when on, returns no candidate when the table exists but is empty, and ignores tc_tranche"
    requirement: BENCHLANE-02
    verification:
      - kind: unit
        ref: "tests/services/test_eval_queue.py::TestBenchmarkSelectionGate::test_benchmark_selection_gate_off_byte_identical_tier4_blob"
        status: pass
      - kind: unit
        ref: "tests/services/test_eval_queue.py::TestBenchmarkSelectionGate::test_benchmark_selection_gate_off_byte_identical_tier4_bestmove"
        status: pass
      - kind: integration
        ref: "tests/services/test_eval_queue.py::TestBenchmarkSelectionGate::test_benchmark_selection_gate_on_narrows_tier4_blob"
        status: pass
      - kind: integration
        ref: "tests/services/test_eval_queue.py::TestBenchmarkSelectionGate::test_benchmark_selection_gate_on_narrows_tier4_bestmove"
        status: pass
      - kind: integration
        ref: "tests/services/test_eval_queue.py::TestBenchmarkSelectionGate::test_benchmark_selection_gate_on_empty_table_returns_no_candidate"
        status: pass
      - kind: integration
        ref: "tests/services/test_eval_queue.py::TestBenchmarkSelectionGate::test_benchmark_selection_gate_ignores_tc_tranche"
        status: pass
      - kind: unit
        ref: "uv run pytest tests/services/test_eval_queue.py -x (60 passed, no regression in the 52 pre-existing tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "assert_benchmark_selection_gate_ready() is a no-op (opens no DB session) when the flag is off, passes when the table exists, and aborts uvicorn startup with a RuntimeError naming benchmark_selection when the flag is on but the table is missing; wired into app/main.py's lifespan before start_engine()"
    requirement: BENCHLANE-02
    verification:
      - kind: unit
        ref: "tests/test_main_lifespan.py::TestBenchmarkSelectionGateAssertion::test_benchmark_gate_assertion_noop_when_flag_off"
        status: pass
      - kind: unit
        ref: "tests/test_main_lifespan.py::TestBenchmarkSelectionGateAssertion::test_benchmark_gate_assertion_passes_when_table_present"
        status: pass
      - kind: unit
        ref: "tests/test_main_lifespan.py::TestBenchmarkSelectionGateAssertion::test_benchmark_gate_assertion_aborts_startup_when_table_missing"
        status: pass
      - kind: unit
        ref: "uv run pytest tests/test_main_lifespan.py -x (6 passed, no regression in the 3 pre-existing lifespan tests)"
        status: pass
      - kind: unit
        ref: "manual verification: temporarily disabling the raise makes test_benchmark_gate_assertion_aborts_startup_when_table_missing fail with 'DID NOT RAISE'; restored and re-verified green"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-08-22
status: complete
---

# Phase 212 Plan 02: Tier-4 Gate Expansion and Fail-Closed Boot Assertion Summary

**Extended the benchmark-selection gate (212-01) from tier-3 alone to all four lottery predicate sites the worker fleet can reach, and added a fail-closed startup assertion that refuses to boot with the gate on and no `benchmark_selection` table.**

## Performance

- **Duration:** 30 min
- **Started:** 2026-08-22T13:45:00Z (approx)
- **Completed:** 2026-08-22T14:16:00Z
- **Tasks:** 2
- **Files modified:** 4 (0 created, 4 modified)

## Accomplishments

- `_selection_gate_clause()` (from 212-01) is now interpolated at all four remaining predicate sites: `_claim_tier4_blob` Stage 1 (`candidate_exists_sql`) and Stage 2 (`game_where_sql`), and `_claim_tier4_bestmove` Stage 1 and Stage 2 — mirroring the exact byte-identity technique used for tier-3 (conditional-space suffix on the last predicate line, never its own interpolated line).
- Verified byte-for-byte identical to the pre-gate baseline with the flag off via a standalone script comparing rendered SQL against frozen literals (`==`), before wiring the change into the test suite.
- 8 new tests in `TestBenchmarkSelectionGate`: flag-off byte-identity for tier-4 blob and tier-4b (2), flag-on narrowing for tier-4 blob and tier-4b (2), an all-four-lanes-return-None assertion against an empty-but-created `benchmark_selection` table (1), and a test pinning the deliberate no-`tc_tranche`-filter decision (D-09) so a future reader can't "fix" it into a tranche-scoped predicate (1) — plus the module docstring updated to record the pin now covers six predicate strings across four sites.
- `assert_benchmark_selection_gate_ready()` added to `app/services/eval_queue_service.py`, immediately below `_selection_gate_clause()`. No-op (opens no DB session at all) when `BENCHMARK_SELECTION_GATE_ENABLED` is False; when True, queries `SELECT to_regclass('public.benchmark_selection')` and raises `RuntimeError` if it resolves to `NULL`.
- Wired into `app/main.py`'s lifespan directly after `cleanup_orphaned_jobs()` and before `start_engine()`, with a comment documenting the two failure modes it catches: a gate-on instance whose benchmark tables were never created, and `DATABASE_URL` left pointing at the dev database (no `benchmark_selection` table there either).
- 3 new tests in `TestBenchmarkSelectionGateAssertion`: no-op-when-off (asserts `async_session_maker` is never called), passes-when-table-present, and aborts-startup-when-table-missing (asserts `RuntimeError` propagates from the lifespan context manager and no `EXPECTED_TASKS` background task is ever spawned). Manually confirmed the third test actually exercises the `raise` — temporarily disabling it made the test fail with "DID NOT RAISE", then restored.

## Task Commits

1. **Task 1: Apply the gate to tier-4 blob and tier-4b best-move lanes (D-09)** - `42cf3583e` (feat)
2. **Task 2: Fail-closed boot assertion when the gate is on and the table is missing** - `fc7a47127` (feat)

## Files Created/Modified

- `app/services/eval_queue_service.py` - `_gate = _selection_gate_clause()` + interpolation at four new sites in `_claim_tier4_blob`/`_claim_tier4_bestmove`; new `assert_benchmark_selection_gate_ready()` function
- `app/main.py` - imports and awaits `assert_benchmark_selection_gate_ready()` in the lifespan, before `start_engine()`
- `tests/services/test_eval_queue.py` - `TestBenchmarkSelectionGate` extended with 8 new tests (byte-identity, narrowing, empty-table, tc_tranche-ignored) covering tier-4 blob and tier-4b
- `tests/test_main_lifespan.py` - new `TestBenchmarkSelectionGateAssertion` class with 3 tests

## Decisions Made

- Gate suffix interpolation at all four new sites reuses 212-01's exact byte-identity technique: `{(" " + _gate) if _gate else ""}` appended to the end of the last predicate line, verified with a standalone script comparing rendered output against frozen baselines via `==` before wiring into the service (same discipline as 212-01, applied to twice as many sites).
- `assert_benchmark_selection_gate_ready()` lives in `eval_queue_service.py`, not `app/core/config.py` next to `assert_secret_key_configured()` — it queries the database (`async_session_maker`), unlike the pure-settings secret-key check, so it belongs next to the predicate it protects rather than in the settings module.
- The `RuntimeError` message is a fixed literal with no interpolated variables (flag name and table name are both constants), per the CLAUDE.md Sentry rule against embedding variable data in error messages — though this particular error is a startup abort, not a Sentry-captured exception, keeping the message static avoids any credential/host leakage in a shared startup log either way.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. `BENCHMARK_SELECTION_GATE_ENABLED` remains off by default; the new boot assertion is inert on every non-benchmark instance including prod.

## Next Phase Readiness

**Ready for 212-05/212-06** (tranche status/record subcommands, classical tranche run) — the gate now covers every lottery lane the worker fleet can reach (`_claim_tier3_derived`, `_claim_tier4_blob`, `_claim_tier4_bestmove`), and a misconfigured local backend (gate on, table missing, or `DATABASE_URL` pointed at the wrong database) fails loudly at startup instead of degrading silently for hours. No blockers.

## Known Stubs

None.

## Threat Flags

None — this plan's threat register (T-212-02, T-212-03, T-212-05, T-212-06) was fully addressed by design: T-212-02 (gate-on/table-missing DoS) and T-212-05 (dev-DB tampering) are both mitigated by `assert_benchmark_selection_gate_ready()`; T-212-03 (SQL fragment tampering) is mitigated by the trusted hardcoded literal, unchanged in shape from 212-01; T-212-06 (error message information disclosure) is mitigated by the fixed-literal error message with no interpolated credentials. No new unaddressed surface was introduced.

## Self-Check: PASSED

All modified files verified present on disk (`app/services/eval_queue_service.py`, `app/main.py`, `tests/services/test_eval_queue.py`, `tests/test_main_lifespan.py`). Both task commits (`42cf3583e`, `fc7a47127`) verified present in `git log`. Full verification suite green: `uv run pytest tests/services/test_eval_queue.py tests/test_main_lifespan.py -x` (66 passed), `uv run ty check app/ tests/` (zero errors), `uv run ruff check app/ tests/` (clean), `uv run ruff format app/ tests/ scripts/` (applied, 2 files reformatted, re-verified green after).

---
*Phase: 212-benchmark-full-game-analysis-lane*
*Completed: 2026-08-22*
