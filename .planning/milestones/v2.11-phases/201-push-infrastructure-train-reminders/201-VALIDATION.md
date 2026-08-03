---
phase: 201
slug: push-infrastructure-train-reminders
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-01
---

# Phase 201 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from `201-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x + pytest-asyncio (`async_mode=auto`) + pytest-xdist, per-run cloned test DB (`tests/conftest.py`) |
| **Config file** | `pyproject.toml` `[tool.pytest.ini_options]` |
| **Quick run command** | `uv run pytest tests/test_push_send.py tests/services/test_train_reminder_service.py tests/routers/test_push.py -x` (exact new-file names at planner's discretion) |
| **Full suite command** | `uv run pytest -n auto` |
| **Estimated runtime** | ~10s quick / ~4 min full suite (`-n auto`) |

---

## Sampling Rate

- **After every task commit:** Run the relevant new test file(s) only — `uv run pytest tests/<new_file>.py -x`
- **After every plan wave:** Run `uv run pytest -n auto`
- **Before `/gsd-verify-work`:** Full backend suite green, plus `cd frontend && npm run lint && npm test -- --run` for the `push-sw.js` / `vite.config.ts` work
- **Max feedback latency:** ~15 seconds (quick run)

---

## Per-Task Verification Map

Task IDs are assigned by the planner; this table is the requirement→test contract each task must satisfy.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | PUSH-01 | — | `push_subscriptions` scoped to `current_active_user.id`, never client-supplied | integration (DB) | `uv run pytest tests/models/test_push_subscription.py -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | PUSH-02 | — | 410/404 prunes the row; other statuses leave it alone | unit (mocked `httpx.AsyncClient.post`) | `uv run pytest tests/test_push_send.py -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | PUSH-03 | T-V6 | Private key never logged, never in a Sentry message, never committed | unit | `uv run pytest tests/routers/test_push.py -k vapid_public_key -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | PUSH-04 | — | No `requests` anywhere in the resolved dependency tree of the send path | static dependency audit | `uv run python -c "import app.services.push_send, sys; assert 'requests' not in sys.modules"` + `uv tree` grep | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | PUSH-05 | — | No Firebase/vendor SDK imported | static dependency audit | same as PUSH-04 | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | PUSH-06 | — | Existing `generateSW` workbox block byte-unchanged apart from the added `importScripts` key | build assertion | `cd frontend && npm run build` then grep `dist/sw.js` for `importScripts(["/push-sw.js"])` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | REMIND-01 | V5 | `reminder_hour` bounded 0–23 at both Pydantic and DB CHECK layers | unit/integration | `uv run pytest tests/test_train_repository.py -k reminder -x` | existing file, new cases | ⬜ pending |
| TBD | TBD | TBD | REMIND-02 | — | Tick interval constant ≥ 15 minutes | unit (constant assertion) | `uv run pytest tests/services/test_train_reminder_service.py -k tick_interval -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | REMIND-03 | — | No reminder on an unscheduled day (reuses `train_scheduler.is_scheduled_day`) | unit | `uv run pytest tests/services/test_train_reminder_service.py -k scheduled_day -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | REMIND-04 | — | Suppressed when a completed `drill_sessions` row exists for local-today | integration (DB) | `uv run pytest tests/services/test_train_reminder_service.py -k already_trained -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | REMIND-05 | — | Claim-then-send: idempotent under a simulated concurrent double-tick | integration (DB, overlapping claim UPDATEs) | `uv run pytest tests/services/test_train_reminder_service.py -k idempotent -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | REMIND-06 | — | Fan-out reaches every live subscription (N calls for N rows) | integration (mocked `httpx`) | `uv run pytest tests/services/test_train_reminder_service.py -k fan_out -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | REMIND-07 | — | Guest users never appear in the candidate query | integration (DB) | `uv run pytest tests/services/test_train_reminder_service.py -k guest_excluded -x` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | REMIND-08 | V4 | Dev-only trigger scoped to the calling user's own subscriptions; 404s outside `development` | integration (router, `ENVIRONMENT` monkeypatched) | `uv run pytest tests/routers/test_push.py -k dev_trigger -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/models/test_push_subscription.py` — CASCADE-delete behavior, unique-endpoint constraint (PUSH-01)
- [ ] `tests/test_push_send.py` — mocked-`httpx` send / prune / log branches, mirroring `tests/test_chesscom_client.py`'s mocking idiom (PUSH-02, PUSH-04)
- [ ] `tests/services/test_train_reminder_service.py` — candidate selection, scheduled-day / hour / already-trained / idempotency / fan-out / guest-exclusion (REMIND-02..07)
- [ ] `tests/routers/test_push.py` — subscribe / unsubscribe / vapid-public-key / dev-trigger endpoints (PUSH-03, REMIND-08)

*No new framework install needed — pytest + pytest-asyncio + the existing per-run-DB isolation cover everything; `unittest.mock` (stdlib) covers the `httpx` mocking.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real end-to-end push delivery to a live browser | PUSH-01..06 (integration) | No subscribe UI exists until Phase 202; only a real browser can produce a valid `PushManager.subscribe()` payload and render an OS notification | In dev, call `PushManager.subscribe({userVisibleOnly: true, applicationServerKey: <dev VAPID public key>})` from the browser devtools console, POST the resulting JSON to `/push/subscribe`, then hit the D-17 dev-only trigger endpoint and confirm an OS notification appears with the expected title/body and that clicking it focuses/opens `/train` (D-13) |
| Safari desktop (macOS) header quirks | PUSH-04 | Requires a Safari 16.4+ macOS device; iOS is explicitly deferred to SEED-132 Phase B | Out of automated reach — flag to operator whether Safari-desktop coverage is expected this phase |
| VAPID private key absent from git and from logs | PUSH-03 | Not expressible as a pytest assertion over the whole repo/log stream | `git log -S` / `git grep` review at merge time; confirm `.env` is gitignored and no fixture embeds a private key literal |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
