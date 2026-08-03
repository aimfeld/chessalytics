---
phase: 202
slug: reminder-permission-ux
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-02
---

# Phase 202 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend-only phase) |
| **Config file** | `frontend/vite.config.ts` |
| **Quick run command** | `cd frontend && npm test -- --run <file>` |
| **Full suite command** | `cd frontend && npm run lint && npm test -- --run && npm run build` |
| **Estimated runtime** | ~{N} seconds |

---

## Sampling Rate

- **After every task commit:** Run `{quick run command}`
- **After every plan wave:** Run `{full suite command}`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** {N} seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 202-01-01 | 01 | 1 | PERM-{XX} | T-202-01 / — | {expected secure behavior or "N/A"} | unit | `{command}` | ✅ / ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Browser-API mocks for `Notification` / `PushManager` / `navigator.serviceWorker` under jsdom — no existing test in this repo stubs them (RESEARCH.md); closest precedent is `vi.stubGlobal('Worker', ...)` in `useTrainGradingEngine.test.ts`
- [ ] Confirm whether `TrainScoreScreen.test.tsx` / `TrainScheduleSettings.test.tsx` already exist (RESEARCH.md open question 3)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real browser permission grant + `PushManager.subscribe()` + end-to-end delivery | PERM-01, PERM-03 | `Notification.requestPermission()` is a one-shot, gesture-gated browser API with no jsdom equivalent | Requires VAPID keys in `.env` (see D-12); use `POST /push/dev/trigger-reminder` to verify delivery without waiting for the clock hour |
| `Notification.permission === 'denied'` disabled Settings row | PERM-03 | Requires a browser-level denial that cannot be reset from JS | Deny at the browser prompt, then reload Settings |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < {N}s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
