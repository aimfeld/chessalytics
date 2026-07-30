---
phase: 193
slug: session-tick-streak-shield
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-28
---

# Phase 193 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (backend, `-n auto` parallel) + vitest (frontend) |
| **Config file** | `pyproject.toml` (backend), `frontend/vite.config.ts` (frontend, no `test:` block — 5s default testTimeout) |
| **Quick run command** | `uv run pytest tests/test_train_scheduler.py tests/test_train_repository.py -q` |
| **Full suite command** | `uv run pytest -n auto -x` then `( cd frontend && npm run lint && npm test -- --run )` |
| **Estimated runtime** | ~15s quick backend · ~4–6 min full backend · ~60s frontend |

---

## Sampling Rate

- **After every task commit:** Run the quick run command (scoped to the files the task touched)
- **After every plan wave:** Run the full suite command for the affected stack
- **Before `/gsd-verify-work`:** Full pre-merge gate green (`ruff format` · `ruff check --fix` · `ty check app/ tests/` · `pytest -n auto -x` · frontend lint + tests)
- **Max feedback latency:** 30 seconds for the quick loop

---

## Per-Task Verification Map

> Filled by the planner/executor as tasks are authored. Every task that changes tick,
> settle, watermark, or badge behavior MUST carry an automated command — this phase's
> highest-risk area (the asymmetric eager/lazy settle machine) is not observable by
> inspection.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | PROG-01 / SCHD-02 | — | N/A (no new attack surface — authenticated own-user state only) | unit | `uv run pytest tests/test_train_scheduler.py -q` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — `tests/test_train_scheduler.py`,
`tests/test_train_repository.py`, and the per-run-DB fixture in `tests/conftest.py` are
already in place, and the frontend has `TrainProgressRow.test.tsx` / `App.test.tsx`.

No new framework install is needed. The following existing tests **pin behavior this
phase deliberately removes** and must be reworked (not deleted wholesale) as part of the
implementing task, not as an afterthought:

- [ ] `tests/test_train_scheduler.py` — `FLAME_LADDER` / `_flame_up` / `_flame_down` / `settle_weeks` / `week_start` cases
- [ ] `tests/test_train_repository.py` — `settle_streak_snapshot` weekly-settlement cases
- [ ] `frontend/src/components/train/__tests__/TrainProgressRow.test.tsx` — flame rendering + `thisWeekHint`
- [ ] `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` — progress payload shape
- [ ] `frontend/src/App.test.tsx` (~lines 610–720) — the `trainWaitingCount` badge block

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Multi-day drain/reset felt end-to-end in a real browser | PROG-01 | Spans calendar days; automatable only by injecting the dev clock, which the unit tests already do — the manual pass validates that the UI narrative (pip depletion → empty meter → reset notice) reads correctly to a human | Start dev stack, use the Train page time-travel strip (`TrainDevClock.tsx`) to advance day-by-day past scheduled days without completing a session; confirm pips deplete one per scheduled day, the count zeroes at 0 pips, and the reset notice persists across a page reload. Then `uv run python scripts/reset_train_state.py --user-id N` to restore a clean slate. |
| 7-pip meter density on a real phone viewport | PROG-01 | Visual/layout judgement at `text-sm` floor; not assertable in jsdom | Load Train page at 360px width; confirm the 7-segment meter and the "N-session streak" label fit without overflow and without dropping below the `text-sm` floor (CLAUDE.md Frontend rule) |
| Badge quiet on an off-day under a narrowed mask | SCHD-02 | Requires a narrowed `weekday_mask` plus a day-boundary crossing | Set a Mon/Wed/Fri mask in Train settings, time-travel to a Tuesday with `waiting_count > 0`, confirm both the desktop header and mobile bottom-bar badges are hidden; then leave a session open across the boundary and confirm the badge returns (D-10) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (never `npm run test:watch` in a verify command)
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
