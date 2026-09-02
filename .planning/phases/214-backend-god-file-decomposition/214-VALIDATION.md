---
phase: "214"
slug: "backend-god-file-decomposition"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-02"
---

# Phase 214 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (pytest-xdist, pytest-asyncio) against a cloned PostgreSQL 18 template DB |
| **Config file** | `pyproject.toml` (`[tool.pytest.ini_options]`), `tests/conftest.py` |
| **Quick run command** | `uv run pytest -n auto tests/<the file's test modules> -q` (per-file oracle, see RESEARCH.md "Validation Architecture") |
| **Full suite command** | `uv run pytest -n auto -x` |
| **Estimated runtime** | quick: 10–60 s per file's oracle; full: several minutes |

Static gates run alongside every quick run: `uv run ruff format app/ tests/ scripts/`, `uv run ruff check . --fix`, `uv run ty check app/ tests/ scripts/`.

---

## Sampling Rate

- **After every task commit:** Run the touched file's test oracle (quick run command) plus `ruff check` and `ty check`
- **After every plan wave:** Run `uv run pytest -n auto -x`
- **Before `/gsd-verify-work`:** Full suite must be green; `tests/` diff shows additions only
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (filled by the planner per plan) | | | — | — | N/A | unit / lint | see RESEARCH.md Validation Architecture | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. The behavior oracle is the existing
test suite per file (RESEARCH.md "Validation Architecture"). Wave 1 (tooling plan) adds
`scripts/check_function_size.py` and the ruff complexity rules; those are new gates, not
new tests.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Mutation check on thin test seams | success criterion 2 | proves tests actually cover an extracted helper | Revert one extracted helper's body to a no-op and confirm the file's oracle fails, then restore |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
