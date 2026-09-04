---
phase: 216-audit-bugs-and-quick-wins
verified: 2026-09-04T20:30:00Z
status: human_needed
score: 7/7 truths verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Post-deploy: query worker_heartbeats.last_ip"
    expected: "SELECT last_ip, max(last_seen) FROM worker_heartbeats GROUP BY 1 ORDER BY 2 DESC LIMIT 5 on prod — newest rows are real ISP/Hetzner addresses, not 162.158.*/104.23.*/172.71.* (Cloudflare)"
    why_human: "Only observable against production after the next /deploy; explicitly scoped as post-deploy HUMAN-UAT in ROADMAP.md and 216-01-PLAN.md"
  - test: "Post-deploy: curl -I https://flawchess.com/ and curl -I https://flawchess.com/api/health"
    expected: "All five headers present (Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Content-Security-Policy-Report-Only), no Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy"
    why_human: "Caddy-set headers only observable against the live origin; the CI deploy job's Health check step asserts this automatically on the next deploy, but that hasn't run yet"
  - test: "Watch Sentry (org flawchess, project 4511084868272208) for incoming CSP violation reports over the following days"
    expected: "Violations, if any, show up as Sentry issues via the report-uri/report-to endpoint, informing whether to widen/narrow a CSP directive before ever enforcing it"
    why_human: "Report-only CSP behavior is only observable from real production traffic"
  - test: "CI after-median run time (SC-4): re-run the recorded command after a few post-merge CI runs exist with the cache warm"
    expected: "gh run list --workflow=ci.yml --limit 10 --json createdAt,updatedAt,conclusion | <median script> compared against the recorded before-median of 567s (n=7)"
    why_human: "Feature branches don't trigger this workflow; the after-measurement can only happen from a real pull_request/workflow_dispatch run post-merge. 216-04-SUMMARY.md documents the exact reproducible command."
---

# Phase 216: Audit Bugs and Quick Wins Verification Report

**Phase Goal:** Close the seven groups in SEED-161 — three verified live production defects
(Cloudflare edge IP forwarding, missing security headers, dead Renovate automation), two
CI/ops quick wins (CI dependency caching, `/api/health` proving the database), the
function-size gate in CI/pre-merge with all eight nesting-depth breaches fixed, and the
housekeeping bundle. No product behavior change; each group independently shippable.

**Verified:** 2026-09-04
**Status:** human_needed (all automated truths pass; four items are explicitly scoped
post-deploy/post-merge HUMAN-UAT per the task brief, not gaps)
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC-1: Caddy trusts exactly the published Cloudflare ranges and reads `Cf-Connecting-Ip`; drift script works | ✓ VERIFIED | `caddy validate` → "Valid configuration"; `caddy adapt` output contains `client_ip_headers` (1) and `trusted_proxies` (1); `bash bin/check_cloudflare_ips.sh` exits 0 against committed Caddyfile, ranges match live cloudflare.com/ips-v4+v6; docs entries present in `docs/dev-tooling.md`/`docs/production-runbook.md` |
| 2 | SC-2: five security headers + report-only CSP ship from Caddy, no COOP/COEP, no enforcing CSP; CI validates config and asserts headers | ✓ VERIFIED | `caddy adapt` JSON contains all 5 header field names (1 each); COOP/COEP grep = 0; enforcing `"Content-Security-Policy"` (non-report-only) grep = 0; `preload` token grep = 0; `.github/workflows/ci.yml` has `Caddyfile validate` step (test job) and `Health check` step (deploy job) extended with a 5-header grep-and-fail loop; existing COOP/COEP guard step untouched |
| 3 | SC-3: Renovate actually running with Dependency Dashboard open; in-range catch-up landed; no major bumps; no automerge | ✓ VERIFIED | `gh issue view 338` shows "Dependency Dashboard" opened by `app/renovate` on 2026-09-04; `git diff main -- renovate.json` empty; `.github/dependabot.yml` absent; README badge line unchanged; `renovate.json` has no `automerge` key, `prConcurrentLimit`/`prHourlyLimit` unchanged; `uv.lock` shows `anthropic 0.122.0` and `complexipy 7.0.1` (both pre-bump, D-05 tripwires held); frontend `package.json` shows `typescript ~6.0.3`, `vitest ^4.1.7`, `jsdom ^29.1.1`, `onnxruntime-web 1.27.0` (all pre-bump) |
| 4 | SC-4: CI installs uv via cached `astral-sh/setup-uv`, caches npm store; before-median recorded | ✓ VERIFIED | `.github/workflows/ci.yml` line 39-41: `astral-sh/setup-uv@v10` with `enable-cache: true`; line 139-143: `actions/setup-node@v6` with `cache: 'npm'` and `cache-dependency-path: frontend/package-lock.json`; no `pip install uv` remains; before-median (567s, n=7) recorded in 216-04-SUMMARY.md with raw per-run durations and a reproducible after-measurement command |
| 5 | SC-5: `/api/health` performs a real DB round-trip under a named timeout, 503 on failure, unchanged success body | ✓ VERIFIED | `app/main.py:309` `_HEALTH_DB_TIMEOUT_S = 2.0`; `health_check` awaits `session.execute(text("SELECT 1"))` inside `asyncio.wait_for(...)`, catches `Exception`, calls `sentry_sdk.capture_exception(exc)`, returns `503 {"status": "degraded"}` on failure / `200 {"status": "ok"}` on success; `uv run pytest tests/test_health.py -q` → 3 passed (happy path, DB-raises, DB-timeout) |
| 6 | SC-6: function-size gate passes with zero breaches (all 8 listed depth violations fixed); gate runs in CI and CLAUDE.md pre-merge block | ✓ VERIFIED | `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` → "OK: 1028 functions scanned, no breaches"; `.github/workflows/ci.yml` has a `Function-size gate` step right after the analysis `ty check` step; `CLAUDE.md` line 71 has the identical command in the pre-merge gate fence; all 8 named functions (fetch_lichess_games, compute_stage_a, compute_stage_b, get_suggestions, fetch_chesscom_games_backward, _make_game_iterator, _build_card, get_time_series) have extracted helper functions present in the diff |
| 7 | SC-7: housekeeping bundle applied (limiter eviction, digest pins, hex literals, alembic compare_type + docstrings, .env.example, orphan worktree) | ✓ VERIFIED | `app/core/ip_rate_limiter.py:45` has `del self._timestamps[ip]`; `feedback_rate_limiter.py`/`reset_password_rate_limiter.py` both import and reuse `_SlidingWindowRateLimiter` (one fix covers all three); `uv run pytest tests/test_ip_rate_limiter.py -q` → 4 passed; `frontend/Dockerfile` both `FROM` lines digest-pinned (`grep -c '^FROM .*@sha256:'` = 2); `#1a1a1a`/`#ffffff` grep in Home.tsx/MaiaMoveQualityBar.tsx = 0, replaced by `SURFACE_DARK`/`PURE_WHITE` in `theme.ts`; `alembic/env.py` has `compare_type=True` x2; independent AST scan finds 11 no-op downgrades, all 11 have real docstrings (0 undocumented); `.env.example` has `OAUTH_TUNNEL_ORIGINS` and `BEST_MOVE_BACKFILL_ENABLED` (the two genuinely-missing fields; the other two benchmark flags correctly stay command-line-only per the file's own comment — not a gap per task brief); `.claude/worktrees/` is empty (orphan worktree removed) |

**Score:** 7/7 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `deploy/Caddyfile` | global trust block + site header block | ✓ VERIFIED | Both blocks present, validate clean, adapt output correct |
| `bin/check_cloudflare_ips.sh` | fetch-and-diff drift script | ✓ VERIFIED | Executable (100755), exits 0 on match; not referenced in CI (D-11 honored) |
| `docs/dev-tooling.md`, `docs/production-runbook.md` | refresh-path docs | ✓ VERIFIED | Both contain `check_cloudflare_ips` references |
| `.github/workflows/ci.yml` | Caddyfile validate, Function-size gate, Health check header assertion, setup-uv cache, setup-node cache | ✓ VERIFIED | All 5 present and correctly placed; YAML parses |
| `app/main.py` | `/api/health` DB round-trip | ✓ VERIFIED | `_HEALTH_DB_TIMEOUT_S`, `SELECT 1`, 503/200 paths present |
| `tests/test_health.py` | 3 tests covering happy/raise/timeout | ✓ VERIFIED | 3 passed |
| `scripts/check_function_size.py` usage in CLAUDE.md | pre-merge gate line | ✓ VERIFIED | Line 71 present |
| `app/core/ip_rate_limiter.py` | key eviction fix | ✓ VERIFIED | `del` present; 4 tests pass |
| `frontend/Dockerfile` | digest-pinned bases | ✓ VERIFIED | 2/2 FROM lines pinned |
| `frontend/src/index.css`, `theme.ts` | hoisted color tokens | ✓ VERIFIED | 0 raw hex literals remain at the 4 named sites |
| `alembic/env.py`, migration files | compare_type + docstrings | ✓ VERIFIED | 2x compare_type=True; 11/11 no-op downgrades documented |
| `.env.example` | two missing fields added | ✓ VERIFIED | Both present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| Caddy global `trusted_proxies`/`client_ip_headers` | `request.client_ip` | Caddy's built-in client-IP resolution | ✓ WIRED | `caddy adapt` compiles both directives into the runtime config |
| `.github/workflows/ci.yml` deploy job Health check | Caddy response headers | `curl -I` + grep-and-fail loop | ✓ WIRED | Step present, structured to fail the release on a missing header (not yet exercised live — see human_verification) |
| `app/main.py health_check` | Postgres | `session.execute(text("SELECT 1"))` under `asyncio.wait_for` | ✓ WIRED / FLOWING | Real DB round-trip via the existing session dependency, confirmed by passing tests exercising both success and failure paths |
| `scripts/check_function_size.py` | CI + CLAUDE.md | New CI step + pre-merge gate line | ✓ WIRED | Both present and pointing at the same command |
| `app/core/ip_rate_limiter.py._SlidingWindowRateLimiter` | `feedback_rate_limiter.py`, `reset_password_rate_limiter.py` | shared class import | ✓ WIRED | One eviction fix covers all three call sites |

### Anti-Patterns Found

None. Scanned all files touched by this phase (Caddyfile, CI workflow, CLAUDE.md, app/main.py,
rate limiter, frontend Dockerfile/theme files, alembic files, .env.example, pyproject.toml,
and the seven depth-fix service/router files) for `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER`
— zero matches. `git status --porcelain` on the branch is clean (only this VERIFICATION.md and
an unrelated `.planning/milestone.lock` are untracked).

### Requirements Coverage

No REQUIREMENTS.md IDs are registered for this phase; ROADMAP.md success criteria SC-1..SC-7
are the contract and are covered above. No orphaned requirements.

### Human Verification Required

### 1. Post-deploy: `worker_heartbeats.last_ip` no longer Cloudflare addresses

**Test:** After the next `/deploy`, run `SELECT last_ip, max(last_seen) FROM worker_heartbeats GROUP BY 1 ORDER BY 2 DESC LIMIT 5` against the prod database.
**Expected:** Newest rows are real ISP/Hetzner addresses, not `162.158.*`, `104.23.*`, or `172.71.*` (Cloudflare ranges).
**Why human:** Only observable against live production traffic after deployment; explicitly scoped as post-deploy HUMAN-UAT in ROADMAP.md SC-1 and 216-01-PLAN.md Task 4.

### 2. Post-deploy: live response headers on flawchess.com

**Test:** `curl -I https://flawchess.com/` and `curl -I https://flawchess.com/api/health`.
**Expected:** All five headers present (HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Content-Security-Policy-Report-Only), no COOP/COEP.
**Why human:** Caddy-set headers are only observable against the live origin. The CI deploy job's Health check step will assert this automatically on the next deploy, but that run hasn't happened yet.

### 3. Sentry CSP violation monitoring

**Test:** Watch Sentry (org `flawchess`, project `4511084868272208`) for CSP violation reports over the following days after deploy.
**Expected:** Any violations surface as Sentry issues via the configured report-uri/report-to endpoint, informing whether to tune the CSP before ever flipping to enforcing.
**Why human:** Only observable from real production traffic patterns.

### 4. CI after-median run time (SC-4)

**Test:** Re-run the documented median-time command (`gh run list --workflow=ci.yml --limit 10 --json createdAt,updatedAt,conclusion | <median script>`, exact command recorded in 216-04-SUMMARY.md) after a handful of post-merge CI runs exist with the cache warm.
**Expected:** Compare against the recorded before-median of 567s (n=7); a lower median confirms the caching quick win paid off.
**Why human:** This workflow only triggers on `pull_request`/`workflow_dispatch`, not on feature-branch pushes, so the after-measurement can't happen until after this phase merges and a release PR runs CI.

### Gaps Summary

No gaps found. All seven SEED-161 groups have working, wired, tested code on the branch.
Four items are correctly scoped as post-deploy/post-merge HUMAN-UAT per the task brief (not
phase-blocking gaps): the Cloudflare client-IP fix and the security headers can only be
observed against live production after `/deploy`; the CI caching after-median needs a
real post-merge CI run; Sentry CSP monitoring is an ongoing observation, not a one-time
check. The `.env.example` "two of four fields" and the Renovate "app already installed,
Mend Silent mode was the blocker" findings documented in the summaries are correctly-scoped
deviations, not gaps, per the verification task's own guidance.

---

_Verified: 2026-09-04_
_Verifier: Claude (gsd-verifier)_
