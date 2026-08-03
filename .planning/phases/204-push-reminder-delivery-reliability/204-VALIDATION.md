---
phase: 204
slug: push-reminder-delivery-reliability
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-03
---

# Phase 204 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (backend) + vitest (frontend) |
| **Config file** | `pyproject.toml` (backend), `frontend/vitest.config.ts` |
| **Quick run command** | `uv run pytest tests/test_push_send.py tests/test_train_reminder_service.py -q` / `(cd frontend && npm test -- --run src/lib/__tests__/push.test.ts)` |
| **Full suite command** | `uv run pytest -n auto` / `(cd frontend && npm run lint && npm test -- --run)` |
| **Estimated runtime** | ~15s quick (backend subset), ~5s quick (frontend file); full suite per CLAUDE.md pre-merge gate |

---

## Sampling Rate

- **After every task commit:** Run the quick command for the stack that task touched
- **After every plan wave:** Run the full suite command for the stack(s) the wave touched
- **Before `/gsd-verify-work`:** Full backend + frontend suites must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

*Populated by the planner from PLAN.md task IDs. Every production change in this phase
must additionally be mutation-tested per ROADMAP success criterion 6 — revert the change,
confirm the named test goes red, restore.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 204-02 Task 1 | 204-02 | 1 | PUSHREL-03 | T-204-08 | Push TTL bounded by end-of-local-day, never 0 | unit | `uv run pytest tests/services/test_train_scheduler.py tests/test_push_send.py -n auto -x -q` | yes | ✅ green |
| 204-02 Task 2 | 204-02 | 1 | PUSHREL-05 | T-204-06 / T-204-07 | Claim released only on total non-delivery; crash-mid-fanout and partial-failure leave it standing | unit | `uv run pytest tests/services/test_train_reminder_service.py -n auto -x -q` | yes | ✅ green |
| 204-02 Task 3 | 204-02 | 1 | PUSHREL-06 | — | Full backend suite, formatter, linter, type checker all green with this plan's changes | full suite | `uv run ruff format --check app/ tests/ && uv run ruff check app/ tests/ && uv run ty check app/ tests/ && uv run pytest -n auto -x -q` | yes | ✅ green |
| 204-03 Task 1 | 204-03 | 2 | PUSHREL-04 | T-204-11 / T-204-12 | Gesture path repairs a VAPID key mismatch (unsubscribe + re-subscribe), reuse unchanged on a match, PERM-01 preserved | unit | `cd frontend && npm test -- --run src/lib/__tests__/push.test.ts src/hooks/__tests__/useDevicePushResync.test.ts` | yes | ✅ green |
| 204-03 Task 2 | 204-03 | 2 | PUSHREL-04 | T-204-13 / T-204-14 | Rotation runbook exists under `docs/`, reachable from `push_send.py` and `CLAUDE.md`, no key material | doc + grep | `test -f docs/push-vapid-rotation-runbook.md && grep -q "push-vapid-rotation-runbook" app/services/push_send.py && grep -q "push-vapid-rotation-runbook" CLAUDE.md` | yes | ✅ green |
| 204-03 Task 3 | 204-03 | 2 | PUSHREL-04 | — | Real-device verification of D2 (prune self-heal), D5 (offline retention), and the D2+D3 composition (same-day recovery) | manual (human-verify checkpoint) | N/A — real device required | n/a | ✅ verified (see Manual-Only Verifications below) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — `tests/test_push_send.py`,
`tests/test_train_reminder_service.py`, and `frontend/src/lib/__tests__/push.test.ts`
already exist with the fixtures and browser-global stubs this phase needs.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions | Result |
|----------|-------------|------------|-------------------|--------|
| A reminder held by the push service through a Doze/offline window is delivered on wake | D5 / criterion 3 | Requires a real push service (FCM/Mozilla autopush) and a real device; no test double can prove retention | On a phone with reminders on: enable airplane mode, trigger `POST /api/push/dev/trigger-reminder`, wait, disable airplane mode, confirm exactly one notification arrives | ✅ PASS — verified on real Android device 2026-08-03 (see 204-03-SUMMARY.md § Real-Device Verification for full evidence, including the TTL default caveat) |
| A device whose row was pruned re-registers on next app load | D2 / criterion 1 | End-to-end across a real service worker + real server row deletion | Delete the user's `push_subscriptions` row in the dev DB, reload the PWA, confirm a new row appears without any UI interaction | ✅ PASS — verified on real Android device 2026-08-03; also confirmed no notification permission prompt appeared (PERM-01) |

Additionally verified on the same device (not originally scheduled as a separate manual-only row, but part of the same checkpoint): the D2+D3 composition — a pruned subscription that self-heals on reload lets a released reminder claim send the SAME day rather than tomorrow. See 204-03-SUMMARY.md for the full transcript, including the test-script correction (corrupt the endpoint rather than deleting the row, since a deleted row removes the user from the tick's candidate set entirely).

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-08-03 — all automated gates green (frontend 3288 tests + lint + knip + build; backend 4044 passed/19 skipped + ruff + ty) and both manual-only behaviors verified on a real device.
