---
phase: 187
slug: guest-game-cleanup-30-day-inactivity-pruning-seed-116
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-24
---

# Phase 187 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (async, per-run cloned DB) |
| **Config file** | `pyproject.toml` / `tests/conftest.py` |
| **Quick run command** | `uv run pytest tests/test_guest_cleanup_service.py` |
| **Full suite command** | `uv run pytest -n auto` |
| **Estimated runtime** | ~5–10 s (single test module) · full suite parallel |

---

## Sampling Rate

- **After every task commit:** Run `uv run pytest tests/test_guest_cleanup_service.py`
- **After every plan wave:** Run `uv run pytest -n auto`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 187-01-* | 01 | 1 | SEED-116 (eligibility + delete + cursor reset) | — | Only `is_guest=true` rows past 30d inactivity are purged; guest User row + auth preserved | unit | `uv run pytest tests/test_guest_cleanup_service.py` | ❌ W0 | ⬜ pending |
| 187-02-* | 02 | 2 | SEED-116 (periodic task wiring) | — | Task spawns on startup, cancels cleanly on shutdown, per-tick errors captured to Sentry | unit | `uv run pytest tests/test_guest_cleanup_service.py` | ❌ W0 | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/test_guest_cleanup_service.py` — new test module for eligibility query, delete + cursor reset, task lifecycle
- [ ] Reuse existing `tests/conftest.py` per-run DB fixture + guest/game factory helpers (no new framework install)

*Existing pytest infrastructure covers all phase requirements; only a new test module is added.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Single large cascade (~5M `game_positions`) WAL/lock impact on shared prod DB | D-06 accepted-risk sanity check | Cannot reproduce prod-scale data volume in the test DB; depends on live prod characteristics | Post-deploy: watch the per-run cleanup log summary + Sentry; if a single guest delete spikes WAL/locks vs live API traffic, enable the documented chunked-delete fallback |
| `last_activity` bumped on real guest browsing (bearer-token requests flow through LastActivityMiddleware) | SEED gotcha #1 | Requires a real browser guest session hitting the deployed API | Load the app as a guest, make an authenticated API call, confirm `users.last_activity` advances (throttled hourly) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
