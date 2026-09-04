---
phase: "216"
slug: "audit-bugs-and-quick-wins"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-04"
---

# Phase 216 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (backend, `pyproject.toml` `[tool.pytest.ini_options]`); vitest (frontend, `frontend/package.json`) |
| **Config file** | `pyproject.toml` (backend), `frontend/vite.config.ts` (frontend) |
| **Quick run command** | `uv run pytest tests/<relevant>.py -x` / `cd frontend && npx vitest run <file>` |
| **Full suite command** | `uv run pytest -n auto -x` / `( cd frontend && npm run lint && npm test -- --run )` |
| **Estimated runtime** | ~180 seconds backend (`-n auto`), ~60 seconds frontend |

---

## Sampling Rate

- **After every task commit:** Run the relevant test file from the map below (e.g. `uv run pytest tests/services/test_user_benchmark_percentiles_service.py -x` after a `compute_stage_*` refactor; `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` after every depth fix).
- **After every plan wave:** Run the full CLAUDE.md pre-merge gate (ruff format, ruff check --fix, ty check both projects, `pytest -n auto -x`, frontend lint + test, plus `npm run build` for the dependency catch-up plan).
- **Before `/gsd-verify-work`:** Full suite must be green AND the function-size gate reports zero breaches.
- **Max feedback latency:** 240 seconds

---

## Per-Task Verification Map

No REQUIREMENTS.md IDs map to this phase; rows are keyed to the seven ROADMAP success criteria (SC-1..SC-7). Task IDs are filled by the planner.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 216-01-xx | 01 | 1 | SC-1 client IP | T-216-01 | Only Cloudflare ranges are trusted proxies; `Cf-Connecting-Ip` honoured only from them | config validate | `docker run --rm -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.11.4 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` | ✅ | ⬜ pending |
| 216-01-xx | 01 | 1 | SC-1 range refresh | — | N/A | script | `bin/check_cloudflare_ips.sh` exits 0 on match, non-zero on drift | ❌ W0 (new script) | ⬜ pending |
| 216-02-xx | 02 | 2 | SC-2 headers | T-216-02 | HSTS/nosniff/Referrer/Permissions/CSP-RO present, no COOP/COEP | CI step | `caddy validate` step in `.github/workflows/ci.yml`; post-deploy `curl -I https://flawchess.com/` grep per header | ❌ W0 (new CI step) | ⬜ pending |
| 216-03-xx | 03 | 1 | SC-3 dependency catch-up | — | N/A | full gate | CLAUDE.md pre-merge gate + `( cd frontend && npm run build )` | ✅ | ⬜ pending |
| 216-04-xx | 04 | 3 | SC-4 CI caching | — | N/A | CI observation | `gh run list --workflow=ci.yml --limit 10 --json createdAt,updatedAt` before/after | ✅ | ⬜ pending |
| 216-05-xx | 05 | 1 | SC-5 `/api/health` | T-216-03 | 503 on DB failure/timeout, no stack details leaked | unit | `uv run pytest tests/test_health.py -x` | ❌ W0 (new test file) | ⬜ pending |
| 216-06-xx | 06 | 4 | SC-6 depth fixes | — | N/A | integration | `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` + the existing test files listed in RESEARCH.md §Validation Architecture | ✅ | ⬜ pending |
| 216-07-xx | 07 | 1 | SC-7 housekeeping | — | N/A | mixed | `uv run pytest tests/ -k rate_limiter -x`; `cd frontend && npm run lint`; `uv run alembic check` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/test_health.py` — happy path (200 `{"status": "ok"}`), DB-raises path (503), DB-timeout path (503); per-test `dependency_overrides` for the session dependency, restored afterwards.
- [ ] `bin/check_cloudflare_ips.sh` — the range-drift script itself is the verification artefact for D-11.
- [ ] `.github/workflows/ci.yml` `caddy validate` step and function-size gate step — CI-side verification for SC-2 and SC-6.

Existing infrastructure covers the eight depth fixes (D-13), the rate limiters, and the frontend lint/test.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real client IP recorded | SC-1 | Prod-only, post-deploy | After `/deploy`, run `SELECT last_ip, max(last_seen) FROM worker_heartbeats GROUP BY 1 ORDER BY 2 DESC LIMIT 5` on prod; no `162.158/104.23/172.71` rows among the newest. |
| Security headers live | SC-2 | Caddy headers only observable on flawchess.com | `curl -I https://flawchess.com/` shows the five headers and no COOP/COEP; the deploy job's health step asserts the same. |
| Renovate App installed | SC-3 | GitHub UI action | Install the Renovate GitHub App on `flawchess/flawchess`; confirm the Dependency Dashboard issue opens. |
| Sentry CSP report key | SC-2 | DSN public key is not in the repo | Copy the security-header report URL from the Sentry project's Client Keys settings page (org `flawchess`, project `4511084868272208`, region de). |
| Orphan worktree removed | SC-7 | Deletes files outside the repo tree | `rm -rf .claude/worktrees/agent-a740fb7ec554451f9` locally; confirm `git worktree list` never listed it. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 240s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
