---
phase: 212
slug: benchmark-full-game-analysis-lane
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-22
---

# Phase 212 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `212-RESEARCH.md` § Validation Architecture. Task IDs are filled in by
> `/gsd-validate-phase` once PLAN.md tasks exist.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest + pytest-asyncio, `asyncio_mode = "auto"` (`pyproject.toml:64-67`) |
| **Config file** | `pyproject.toml` `[tool.pytest.ini_options]` (`:64-74`) |
| **Quick run command** | `uv run pytest tests/services/test_eval_queue.py tests/test_remote_eval_worker.py -x` |
| **Full suite command** | `uv run pytest -n auto` |
| **Estimated runtime** | ~15 s quick · ~6 min full suite |

Note: `tests/scripts/benchmarks` is excluded by default via `addopts` (`pyproject.toml:74`) and is
NOT the right home for this phase's tests — those are numeric-regression tests against
`benchmarks-latest.md`, a different concern.

---

## Sampling Rate

- **After every task commit:** Run `uv run pytest <targeted test file(s)> -x`
- **After every plan wave:** Run `uv run pytest tests/services/test_eval_queue.py tests/test_remote_eval_worker.py tests/test_benchmark_lane.py tests/services/test_eval_apply.py -n auto`
- **Before `/gsd-verify-work`:** Full suite must be green (`uv run pytest -n auto`)
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | BENCHLANE-01 | — | N/A | unit/integration | `uv run pytest tests/test_benchmark_lane.py::test_persist_selection_idempotent -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BENCHLANE-02 | T-212-02 | Gate predicate byte-identical when off | unit | `uv run pytest tests/services/test_eval_queue.py -k benchmark_selection_gate -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BENCHLANE-02 | T-212-02 | Boot assertion refuses start with gate on + table missing (fail-closed, not silent ungated fallthrough) | unit | `uv run pytest tests/test_config_boot_assertions.py -k benchmark_selection -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BENCHLANE-03 | — | N/A | unit | `uv run pytest tests/test_remote_eval_worker.py -k fallback -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BENCHLANE-03 | — | N/A | unit | `uv run pytest tests/test_remote_eval_worker.py -k unreachable_primary -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BENCHLANE-04 | T-212-01 | Second backend uses its own `EVAL_OPERATOR_TOKEN`, not prod's | manual/script | `bin/benchmark_db.sh start` then diff `alembic current` (5433) against dev head | N/A (existing script) | ⬜ pending |
| TBD | TBD | TBD | BENCHLANE-05 | — | N/A | integration | `uv run pytest tests/services/test_eval_apply.py -k homogenization -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | BENCHLANE-06 | — | N/A | unit | `uv run pytest tests/test_benchmark_lane.py::test_record_writes_report -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/test_benchmark_lane.py` — new file, covers BENCHLANE-01/06; mirror the pure-unit +
      `create_all`-idempotency shape of `tests/test_benchmark_ingest.py` (10 existing test functions,
      notably `test_persist_selection_compound_dedup` at `:334`)
- [ ] Gate byte-identity + bites-when-on tests added to `tests/services/test_eval_queue.py`
      (existing file, 52 tests; module docstring already pins tier-4 blob / bestmove byte-identity)
- [ ] Boot-assertion test for the gate-on-but-table-missing case — planner/executor must first
      confirm whether an app-startup test module already exists under a name not grepped during
      research (e.g. `tests/test_main.py`, `tests/test_startup.py`) before creating a new file
- [ ] Fallback-routing tests added to `tests/test_remote_eval_worker.py` (existing file; not read
      in full during research — read it before extending)
- [ ] Framework install: none — pytest / pytest-asyncio already present

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Benchmark DB Alembic head on :5433 matches `main`'s head | BENCHLANE-04 | Requires the live benchmark Postgres container; not reproducible in the per-run test DB | `bin/benchmark_db.sh start`, then compare `alembic current` against 5433 with the dev head |
| Second backend produces full pipeline output end to end on a small tranche (`best_move` + `pv` on `game_positions`, `game_flaws` rows, `game_best_moves` rows) | BENCHLANE-04 | Needs the real worker fleet plus a live second uvicorn instance; an integration test cannot stand in for real Stockfish throughput | Run the local backend on :8001 against 5433 with the gate on, point one worker at it, confirm the three tables populate for the tranche games |
| Classical tranche completion (or operator stop at a TC boundary) with row counts recorded and post-run vacuum performed | BENCHLANE-06 | Long-running operational task measured in hours; outcome is a recorded artifact, not an assertion | Run the tranche, then the `record` subcommand, then `VACUUM (ANALYZE)` on the benchmark DB |
| Eval-source homogeneity decision written down before classical starts | BENCHLANE-05 | The decision itself is a human judgement; only its implementation is testable | Confirm the choice and its consequence for §6-style comparisons are recorded in the phase artifacts |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
