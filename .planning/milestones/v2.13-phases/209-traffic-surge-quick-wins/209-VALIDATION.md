---
phase: 209
slug: traffic-surge-quick-wins
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-10
---

# Phase 209 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (backend, `-n auto`), vitest (frontend) |
| **Config file** | `pyproject.toml` (pytest), `frontend/vitest.config.ts` |
| **Quick run command** | `uv run pytest tests/test_import_service.py tests/test_guest.py` / `cd frontend && npm test -- --run src/hooks/useReadiness.test.tsx` |
| **Full suite command** | `uv run pytest -n auto -x` and `cd frontend && npm run lint && npm test -- --run` |
| **Estimated runtime** | quick ~20 s; full backend ~3–4 min parallel |

---

## Sampling Rate

- **After every task commit:** Run the quick command scoped to the touched stack
- **After every plan wave:** Run the full suite command (both stacks)
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 240 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| (filled by planner) | | | SURGE-01..07 | — | | | | | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — `frontend/src/hooks/useReadiness.test.tsx` (fake-timer harness) and `tests/test_import_service.py` (`_seed_job` helper) already exist as seams; no new framework or conftest work is expected.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CDN serves `/maia/*`, `/engine/*` from cache; `maia-worker.js` stays no-cache | SURGE-03 | DNS/CDN cutover is operator work; no staging env by locked constraint | After Cloudflare cutover: `curl -sI https://flawchess.com/maia/maia3_simplified.onnx` twice — second response shows `cf-cache-status: HIT`; `curl -sI https://flawchess.com/maia/maia-worker.js` shows `no-cache` and `cf-cache-status` BYPASS/DYNAMIC; `dig` mail records against Cloudflare match pre-cutover values; send + receive one test email |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 240s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
