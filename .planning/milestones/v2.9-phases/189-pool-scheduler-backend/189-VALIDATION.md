---
phase: 189
slug: pool-scheduler-backend
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-25
---

# Phase 189 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (asyncio, per-run cloned PostgreSQL template DB) |
| **Config file** | `tests/conftest.py` (per-run DB isolation, auto-refreshing migrated template) |
| **Quick run command** | `uv run pytest tests/services/test_train_scheduler.py` (or the specific test file touched) |
| **Full suite command** | `uv run pytest -n auto -x` |
| **Estimated runtime** | ~120 seconds (full, parallel) |

---

## Sampling Rate

- **After every task commit:** Run the targeted test file(s) for the task (serial)
- **After every plan wave:** Run `uv run pytest -n auto -x`
- **Before `/gsd-verify-work`:** Full suite must be green, plus `uv run ruff check .` and `uv run ty check app/ tests/`
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-T1 (tracer) | 189-01 | 1 | POOL-01, POOL-10 | T-189-01/02/03/04 | user-scoped pool query; closed 5-field pre-attempt payload; explicit 403 guest gate; drill_items FK targets are users+games only | integration | `uv run alembic upgrade head && uv run pytest tests/routers/test_train.py -x -q` | ❌ W0 | ⬜ pending |
| 01-T2 | 189-01 | 1 | POOL-04, POOL-05, POOL-06 | — | pure functions, no I/O surface | unit | `uv run pytest tests/services/test_train_scheduler.py -q` | ❌ W0 | ⬜ pending |
| 02-T1 | 189-02 | 2 | POOL-09 | T-189-06/07 | FK cascade removes drill rows; drill_sessions survival asserted | integration | `uv run pytest tests/test_imports_router.py -q -k "drill or delete_games"` | ✅ extend | ⬜ pending |
| 02-T2 | 189-02 | 2 | POOL-09 | T-189-06 | guest purge leaves no orphans | integration | `uv run pytest tests/test_guest_cleanup_service.py -q` | ✅ extend | ⬜ pending |
| 03-T1 | 189-03 | 2 | POOL-02 | T-189-10/11 | degenerate blob never raises; type never ships pre-attempt | unit | `uv run pytest tests/services/test_train_pool.py -q -k "classify or expected_score or soft_blob"` | ❌ W0 | ⬜ pending |
| 03-T2 | 189-03 | 2 | POOL-03 | T-189-09 | herring scoping via Game.user_id correlation (no user_id column exists) | integration | `uv run pytest tests/services/test_train_pool.py -q -k herring` | ❌ W0 | ⬜ pending |
| 04-T1 | 189-04 | 3 | POOL-07, POOL-01, POOL-03 | T-189-13/15 | thin-pool signal present; TrainPuzzle stays closed | integration | `uv run pytest tests/repositories/test_train_repository.py -q` | ❌ W0 | ⬜ pending |
| 04-T2 | 189-04 | 3 | POOL-07 | T-189-12/14 | session load is user-scoped; one open session under concurrency | integration | `uv run pytest tests/repositories/test_train_repository.py tests/routers/test_train.py -q` | ❌ W0 | ⬜ pending |
| 05-T1 | 189-05 | 4 | POOL-08, POOL-04, POOL-05, POOL-06 | T-189-16/18/19/21 | foreign session 404; single SR advance under concurrent submit | integration | `uv run pytest tests/routers/test_train.py -q -k "solve or guess or complete"` | ❌ W0 | ⬜ pending |
| 05-T2 | 189-05 | 4 | POOL-10 | T-189-17 | reveal 409 before attempt, no answer-key keys in body | integration | `uv run pytest tests/routers/test_train.py -q -k reveal` | ❌ W0 | ⬜ pending |
| 05-T3 | 189-05 | 4 | POOL-04 | T-189-20/21 | unresolvable IANA zone rejected 422 at the boundary | integration | `uv run pytest tests/routers/test_train.py -q -k settings` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/services/test_train_scheduler.py` — pure-function ladder/snapping unit tests (zero I/O) — Plan 189-01
- [ ] `tests/services/test_train_pool.py` — classifier unit tests + herring-query integration tests — Plan 189-03
- [ ] `tests/repositories/test_train_repository.py` — composition mix, padding, lifecycle, eviction — Plan 189-04
- [ ] `tests/routers/test_train.py` — endpoint tests (compose, guest gate, payload shape, solve, reveal, settings) — Plans 189-01/04/05
- [ ] Extend `tests/test_imports_router.py` and `tests/test_guest_cleanup_service.py` — POOL-09 cascade at the two real delete paths — Plan 189-02

*Existing pytest + per-run-DB infrastructure covers the framework; only test files are new.
Paths use the repo's `tests/{services,repositories,routers}/` layout (the earlier flat
`tests/test_train_*.py` sketch in this file was corrected at plan time).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| (none expected — backend-only phase; all behaviors testable via pytest) | | | |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
