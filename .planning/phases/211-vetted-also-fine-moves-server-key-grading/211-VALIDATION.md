---
phase: 211
slug: vetted-also-fine-moves-server-key-grading
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-16
---

# Phase 211 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (backend) + vitest via `npm test` (frontend) |
| **Config file** | `pyproject.toml` / `frontend/vitest` config (existing) |
| **Quick run command** | `uv run pytest tests/test_train_router.py tests/test_train_pool.py` (backend) · `(cd frontend && npm test -- --run src/hooks src/components/train src/lib)` (frontend, scoped) |
| **Full suite command** | `uv run pytest -n auto -x` · `(cd frontend && npm run lint && npm test -- --run)` |
| **Estimated runtime** | quick ~30–60 s · full ~3–5 min |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the touched stack (backend or frontend)
- **After every plan wave:** Run both full suite commands
- **Before `/gsd-verify-work`:** Full suite must be green, plus `uv run ty check app/ tests/` and `(cd frontend && npx tsc -b)` (project rule: lint+test do not type-check)
- **Max feedback latency:** 300 s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (filled by planner) | — | — | VETFINE-XX | — | P-01: no key material pre-attempt | unit/integration | see plans | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements (backend train router/pool suites and
frontend train hook/component suites already exist; new tests slot into them).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real-Stockfish reveal: vetted "Also fine" arrows + played-key-move verdict agree on a live puzzle | D-01/D-03 | Real WASM engine + real DB blob interplay; mirrors Phase 205's operator-confirmed browser check | Solve a soft puzzle in the dev app playing the vetted `su` move; confirm verdict badge, arrow color, and "Also fine" row agree; repeat on a sharp puzzle (no alternatives shown) and a herring |
| Width-1 mount search UX: "Checking your move…" wait acceptable on off-key moves | D-05 | Perceived latency judgment | Play a non-best off-key move; observe single ~1.5 s check |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 300s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
