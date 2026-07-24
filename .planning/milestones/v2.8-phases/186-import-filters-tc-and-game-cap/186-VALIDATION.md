---
phase: 186
slug: import-filters-tc-and-game-cap
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-24
---

# Phase 186 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (backend), vitest (frontend) |
| **Config file** | pyproject.toml / frontend/vite.config.ts |
| **Quick run command** | `uv run pytest tests/<target_test_file>.py` |
| **Full suite command** | `uv run pytest -n auto -x` |
| **Estimated runtime** | ~120 seconds (full backend suite, parallel) |

---

## Sampling Rate

- **After every task commit:** Run `uv run pytest tests/<target_test_file>.py`
- **After every plan wave:** Run `uv run pytest -n auto -x`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-1 (tracer) | 186-01 | 1 | IMPORT-01/02 | T-186-01, T-186-02 | Settings scoped to current_active_user; Literal cap validation | unit + migration | `uv run alembic upgrade head && uv run pytest tests/test_users_router.py -k import_settings tests/test_import_service.py -k "tc_filter or grandfather" -x` | ❌ new cases | ⬜ pending |
| 01-2 | 186-01 | 1 | IMPORT-04 | T-186-01 | Backlog counts scoped by user_id | unit | `uv run pytest tests/test_game_repository.py -k backlog tests/test_users_router.py -k backlog_counts -x` | ❌ new cases | ⬜ pending |
| 02-1 | 186-02 | 2 | IMPORT-03 | — | Outbound fetch only | integration (mocked httpx) | `uv run pytest tests/test_lichess_client.py -k backward tests/test_chesscom_client.py -k backward -x` | ❌ extend existing | ⬜ pending |
| 02-2 | 186-02 | 2 | IMPORT-03 | T-186-03 | Sync-gated; one-active-job index; settings snapshot read once at job start (D-04) | integration | `uv run pytest tests/test_import_service.py -k "backward or two_pass or first_sync or budget or mid_run_settings" -x` | ❌ new cases | ⬜ pending |
| 02-3 | 186-02 | 2 | IMPORT-03 | T-186-04 | Delete/cursor reset scoped to user.id | unit | `uv run pytest tests/test_imports_router.py -k "delete and cursor" -x` | ❌ new cases | ⬜ pending |
| 03-1 | 186-03 | 2 | IMPORT-01 | T-186-06 | Backend re-validates cap | build+lint | `cd frontend && npx tsc -b && npm run lint` | ❌ new files | ⬜ pending |
| 03-2 | 186-03 | 2 | IMPORT-04 | T-186-05 | Authenticated apiClient session | build+lint | `cd frontend && npx tsc -b && npm run lint` | ❌ new markup | ⬜ pending |
| 03-3 | 186-03 | 2 | IMPORT-01 | — | Mocked hook (no backend) | component | `cd frontend && npx vitest run src/components/filters/__tests__/ImportFilterCard.test.tsx` | ❌ new file | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

All test files/frameworks already exist; each task creates its own new cases inline (TDD `tdd="true"` on the code-producing backend tasks). No separate Wave 0 scaffolding plan is needed:
- `tests/test_users_router.py` — extend with `import_settings` / `backlog_counts` cases (IMPORT-01/04)
- `tests/test_game_repository.py` — add `backlog` GROUP BY cases (IMPORT-02/04)
- `tests/test_import_service.py` — add `tc_filter` / `grandfather` / `backward` / `two_pass` / `first_sync` / `budget` cases (IMPORT-02/03)
- `tests/test_lichess_client.py` / `tests/test_chesscom_client.py` — extend the mocked-httpx harness with `backward` cases (IMPORT-03)
- `tests/test_imports_router.py` — add `delete and cursor` case (IMPORT-03)
- `frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx` — new RTL component test (IMPORT-01)

Framework install: none — pytest + vitest already present.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| (filled at plan time) | | | |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
