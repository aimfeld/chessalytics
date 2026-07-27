---
phase: 191
slug: schedule-progress-surface
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-27
---

# Phase 191 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (backend) + vitest (frontend) |
| **Config file** | `pyproject.toml` (pytest), `frontend/vite.config.ts` (vitest) |
| **Quick run command** | `uv run pytest tests/<file>::<test> -q` / `cd frontend && npm test -- --run <file>` |
| **Full suite command** | `uv run pytest -n auto` / `cd frontend && npm run lint && npm test -- --run` |
| **Estimated runtime** | ~180 seconds (backend, parallel) + ~60 seconds (frontend) |

---

## Sampling Rate

- **After every task commit:** Run the task's targeted quick command
- **After every plan wave:** Run the full suite for the stack(s) touched
- **Before `/gsd-verify-work`:** Full pre-merge gate must be green (`ruff format`, `ruff check`, `ty check`, `pytest -n auto`, frontend lint + tests)
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

*Populated by the planner from PLAN.md task IDs. Seeded as draft by plan-phase.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | SCHD-01..03, PROG-01..05 | TBD | TBD | unit | TBD | TBD | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements — pytest with per-run DB isolation (`tests/conftest.py`) and vitest are both established. No framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Confetti burst renders and respects `prefers-reduced-motion` | PROG-03 | Visual animation timing is not assertable in jsdom beyond the reduced-motion branch | Complete a green-rated session with reduced motion off, then on; confirm burst appears then is suppressed |
| Nav badge visual placement on mobile bottom bar and desktop header | SCHD-02 | Layout/overflow behavior at real viewport widths | Load app on a scheduled day at 375px and 1440px; confirm badge is legible and not clipped |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
