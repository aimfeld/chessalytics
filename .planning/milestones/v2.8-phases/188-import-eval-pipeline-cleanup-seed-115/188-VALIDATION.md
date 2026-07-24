---
phase: 188
slug: import-eval-pipeline-cleanup-seed-115
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-24
---

# Phase 188 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (via uv), per-run cloned Postgres template DB |
| **Config file** | `pyproject.toml` + `tests/conftest.py` |
| **Quick run command** | `uv run pytest tests/services/test_eval_queue.py tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py -x` |
| **Full suite command** | `uv run pytest -n auto` |
| **Estimated runtime** | quick ~10s, full ~3-4 min |

---

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` command (see map below)
- **After every plan wave:** Run `uv run pytest -n auto`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~240 seconds (full suite)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 188-01-01 | 01 | 1 | D-01, D-03, D-05 | — | docstring-only diff (no behavior change) | unit | `uv run pytest tests/services/test_eval_queue.py tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py -x` | ✅ | ⬜ pending |
| 188-01-02 | 01 | 1 | D-04, D-06 | T-188-02 | active `remote_eval_worker.py` imports intact; `pytest --collect-only` clean after prune | unit | `uv run pytest tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py tests/test_remote_eval_worker.py -x` | ✅ | ⬜ pending |
| 188-01-03 | 01 | 1 | D-07 | T-188-01, T-188-03 | model Index text and migration `postgresql_where` byte-identical; non-concurrent per 174-07 precedent | migration round-trip | `uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head` | ✅ | ⬜ pending |
| 188-01-04 | 01 | 1 | D-02, D-08, D-09 (fences) | T-188-SC | full green suite proves no-behavior-change fences | full gate | `uv run ty check app/ tests/ && uv run pytest -n auto` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — this is a deletion/docstring/migration
phase; no new test files or fixtures are needed. Deletion claims are proven by the existing
suite staying green AFTER removal (mutation-honest per project memory), not by new tests.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Archived scripts remain invocable from `scripts/archive/` | D-04 | one-off smoke, not worth a permanent test | `uv run python scripts/archive/backfill_multipv.py --help` exits 0 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none)
- [x] No watch-mode flags
- [x] Feedback latency < 240s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-07-24
