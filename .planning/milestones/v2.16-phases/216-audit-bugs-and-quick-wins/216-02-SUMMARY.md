---
phase: 216-audit-bugs-and-quick-wins
plan: 02
subsystem: infra
tags: [caddy, csp, security-headers, sentry, ci, github-actions]

# Dependency graph
requires:
  - phase: 216-01
    provides: "deploy/Caddyfile global servers{} trust block (Cloudflare ranges + client_ip_headers) that this plan's site-level header block sits alongside, unmodified"
provides:
  - "deploy/Caddyfile flawchess.com site block: unconditioned header{} with HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Content-Security-Policy-Report-Only (report-uri + report-to), Reporting-Endpoints"
  - ".github/workflows/ci.yml Caddyfile validate step (test job, pre-merge gate)"
  - ".github/workflows/ci.yml Health check step (deploy job) now asserts all five security headers post-deploy"
affects: [216-audit-bugs-and-quick-wins, deploy]

# Actuals (#2632)
actuals:
  tokens: 3600
  tasks: 2
  commits: 2
  # Task 1 (checkpoint:human-action) was pre-resolved by the orchestrator before
  # this run; no code change or commit for it. Actuals cover Tasks 2-3 only
  # (chars/4 over deploy/Caddyfile + .github/workflows/ci.yml diffs).

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Caddyfile site-level header{} block placed unconditioned before any handle — relies on Caddy's fixed directive order (header before handle/reverse_proxy/file_server) to cover static assets, /api/*, and the SPA fallback from one block, matching the existing Pattern established by the global servers{} trust block in 216-01"
    - "CI grep-based header assertion with a FAIL accumulator (one line per header, report every miss not just the first) — same idiom as the existing No COOP/COEP guard step"

key-files:
  modified:
    - deploy/Caddyfile
    - .github/workflows/ci.yml

key-decisions:
  - "Task 1's Sentry security-report endpoint URL was supplied by the orchestrator, sourced from the Sentry project's Client Keys (DSN) page via the Sentry API/MCP — NOT reconstructed from repo contents or an env file. Value: https://o4511084502450176.ingest.de.sentry.io/api/4511084868272208/security/?sentry_key=5ac850dda8e5ec8b838c6dfbf50fc89d. Verified: path segment is /api/4511084868272208/security/, carries sentry_key=, and a test POST with Content-Type: application/csp-report returned HTTP 200."
  - "Reworded the HSTS rationale comment mid-task after the first verification pass: the literal word 'preload' in the comment tripped the plan's own `grep -c 'preload' deploy/Caddyfile` acceptance gate (which exists to prove the preload token itself is absent), even though no preload directive was actually set. Reworded to 'browser HSTS-list opt-in directive' to keep the same meaning without the literal substring."
  - "Report-uri/Reporting-Endpoints value appears exactly twice in deploy/Caddyfile (once inside the CSP directive string, once in the Reporting-Endpoints header) — matches the plan's acceptance range of 1-2 occurrences, confirming the URL wasn't pasted anywhere else."

requirements-completed: []

coverage:
  - id: D1
    description: "flawchess.com site block sets HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and Content-Security-Policy-Report-Only unconditionally on every response (static, /api/*, SPA fallback)"
    verification:
      - kind: other
        ref: "docker run caddy:2.11.4 caddy validate --config deploy/Caddyfile --adapter caddyfile"
        status: pass
      - kind: other
        ref: "docker run caddy:2.11.4 caddy adapt ... | grep -c <each of the 6 header field names>"
        status: pass
      - kind: other
        ref: "awk/grep confirming the header{} block precedes handle @static, handle /api/*, and the SPA-fallback handle (not nested inside any)"
        status: pass
    human_judgment: false
  - id: D2
    description: "CSP is report-only, points at the real Sentry endpoint via both report-uri and report-to/Reporting-Endpoints, and no COOP/COEP header is added anywhere"
    verification:
      - kind: other
        ref: "grep -c 'Content-Security-Policy \"' deploy/Caddyfile (0 — only the report-only variant set)"
        status: pass
      - kind: other
        ref: "docker run caddy:2.11.4 caddy adapt ... | grep -ci 'cross-origin-opener-policy|cross-origin-embedder-policy' (0)"
        status: pass
      - kind: other
        ref: "grep -c 'sentry_key=' deploy/Caddyfile (2)"
        status: pass
    human_judgment: false
  - id: D3
    description: "CI validates the Caddyfile pre-merge (new 'Caddyfile validate' step) and the deploy job's Health check step asserts all five headers post-deploy, without disturbing the existing COOP/COEP guard"
    verification:
      - kind: other
        ref: "uv run python -c \"import yaml; ...\" step-name assertion (steps ok)"
        status: pass
      - kind: other
        ref: "docker run caddy:2.11.4 caddy validate (the exact command the new CI step runs) exits 0 locally"
        status: pass
      - kind: other
        ref: "header-grep pattern exercised both directions: all-present -> present-case=0, one-missing -> missing-case=1"
        status: pass
      - kind: other
        ref: "sed -n '/name: Health check/,/^      - name:/p' .github/workflows/ci.yml | grep -c 'exit 0' (0)"
        status: pass
      - kind: other
        ref: "git diff .github/workflows/ci.yml shows zero lines touched inside the 'No COOP/COEP header guard + WASM MIME check' step"
        status: pass
    human_judgment: false
  - id: D4
    description: "Post-deploy confirmation that flawchess.com and flawchess.com/api/health actually emit the five headers and no COOP/COEP, then monitor Sentry for incoming CSP violation reports"
    verification: []
    human_judgment: true
    rationale: "Caddy-set headers are only observable against the live flawchess.com origin, and this phase ends at squash-merge to main. Recorded as HUMAN-UAT in Task 3's <human-check>: curl -I against both / and /api/health after the next /deploy, then watch Sentry for CSP violation reports over the following days (report-only means a violation is a tuning signal, never an outage)."

duration: ~15min
completed: 2026-09-04
status: complete
---

# Phase 216 Plan 02: Security Response Headers + Report-Only CSP Summary

**flawchess.com now ships HSTS, nosniff, Referrer-Policy, Permissions-Policy and a Sentry-reporting CSP from one unconditioned Caddy header block, with CI validating the config pre-merge and asserting the headers post-deploy.**

## Performance

- **Duration:** ~15 min (Task 1 pre-resolved by orchestrator before this run)
- **Started:** 2026-09-04T18:58:00+02:00 (approx, this session)
- **Completed:** 2026-09-04T19:05:36+02:00
- **Tasks:** 2 executed this run (Task 1 checkpoint pre-resolved, no commit; Task 2 tracer, Task 3 auto)
- **Files modified:** 2

## Accomplishments
- Added an unconditioned `header { }` block to the `flawchess.com { }` site body in `deploy/Caddyfile`, placed after `encode gzip` and before the access-log block: `Strict-Transport-Security "max-age=31536000; includeSubDomains"` (no preload token), `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, `Permissions-Policy "camera=(), microphone=(), geolocation=()"`, and a `Content-Security-Policy-Report-Only` built from RESEARCH.md's per-directive evidence table (script/style/font/img/connect/worker-src, frame-ancestors, base-uri, form-action) reporting to Sentry via both `report-uri` and `report-to csp-endpoint` / `Reporting-Endpoints`.
- Confirmed via `caddy validate`/`caddy adapt` that the block validates, contains all six field names, has zero COOP/COEP matches, sets no enforcing `Content-Security-Policy`, carries no preload token, and left every existing `Cache-Control` line untouched.
- Added a `Caddyfile validate` step to the CI test job (runs `caddy:2.11.4 caddy validate` against the committed file), and extended the deploy job's `Health check` step: the loop now uses a `SUCCESS` flag + `break` instead of an in-loop `exit 0`, and after a successful health check it asserts all five headers via a case-insensitive grep with a `FAIL` accumulator, exiting 1 if any is missing.
- Left the existing `No COOP/COEP header guard + WASM MIME check` step byte-identical (confirmed via `git diff`), and added no `caddy fmt` step (this Caddyfile is deliberately 4-space indented, not `caddy fmt`-clean).

## Task Commits

Each task was committed atomically:

1. **Task 1: Obtain the Sentry security-report endpoint URL** — no commit (checkpoint:human-action, pre-resolved by the orchestrator before this run; value recorded above under Decisions Made)
2. **Task 2: Site-level security header block** — `43dd1c42c` (feat)
3. **Task 3: CI assertions — caddy validate pre-merge, header assertion post-deploy** — `fe1408f1b` (feat)

**Plan metadata:** pending (this commit, `docs(216-02): complete plan`)

## Files Created/Modified
- `deploy/Caddyfile` — new unconditioned `header { }` block in the `flawchess.com` site body (Task 2)
- `.github/workflows/ci.yml` — new `Caddyfile validate` step (test job) + extended `Health check` step (deploy job) (Task 3)

## Decisions Made

**Task 1 (pre-resolved):** the Sentry security-report endpoint URL came from the Sentry project's Client Keys (DSN) page via the Sentry API/MCP, not from repo contents or an env file — `https://o4511084502450176.ingest.de.sentry.io/api/4511084868272208/security/?sentry_key=5ac850dda8e5ec8b838c6dfbf50fc89d`. Its provenance was verified (path segment `/api/4511084868272208/security/`, `sentry_key=` query param, test POST returned HTTP 200) before this run began.

Everything else followed RESEARCH.md's Pattern 2 (site-level unconditioned header) / Pattern 3 (CSP directive derivation) / Pattern 4 (Sentry endpoint format) without deviation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] HSTS rationale comment tripped its own acceptance-gate grep**
- **Found during:** Task 2 (first verification pass)
- **Issue:** The inline comment above the HSTS header line said "no preload token", but the plan's own acceptance criterion runs `grep -c 'preload' deploy/Caddyfile` and expects `0` — the comment's literal use of the word "preload" made the grep match even though no preload directive was set.
- **Fix:** Reworded the comment to "the browser HSTS-list opt-in directive is deliberately left off (D-06)" — same meaning, no literal substring match.
- **Files modified:** `deploy/Caddyfile`
- **Verification:** Re-ran `grep -c 'preload' deploy/Caddyfile` → `0`; full verification suite re-run and passing.
- **Committed in:** `43dd1c42c` (part of Task 2's commit — caught before the first commit, not a separate fix commit)

---

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** Cosmetic-only fix to a code comment before the first commit; no functional change, no scope creep.

## Issues Encountered
None.

## User Setup Required

None for this run — Task 1's external Sentry lookup was already completed by the orchestrator before dispatch (see Decisions Made above). No further manual configuration required.

## Next Phase Readiness

Wave 2 plan 216-02 is complete and ready for squash-merge alongside the rest of Phase 216. Two items are explicitly deferred to post-deploy HUMAN-UAT (Task 3's `<human-check>`, not a phase gate):
1. `curl -I https://flawchess.com/` and `curl -I https://flawchess.com/api/health` after the next `/deploy` must show all five headers and no COOP/COEP.
2. Watch Sentry for incoming CSP violation reports over the following days — report-only means a violation is a tuning signal, never an outage, and may motivate widening or narrowing a directive before ever flipping to enforcing.

No blockers for merging this plan's work into `main`.

## Self-Check: PASSED

- `deploy/Caddyfile` contains the new `header { }` block: FOUND (validated via `caddy validate`/`caddy adapt`)
- `.github/workflows/ci.yml` contains `Caddyfile validate` step and extended `Health check` step: FOUND
- Commit `43dd1c42c` exists on branch: FOUND
- Commit `fe1408f1b` exists on branch: FOUND
- All plan-level `<verification>` commands re-run and passing (caddy validate/adapt, YAML parse + step-name assertion, header-grep pattern exercised both directions, `exit 0` absent from Health check, COOP/COEP step untouched)

---
*Phase: 216-audit-bugs-and-quick-wins*
*Completed: 2026-09-04*
