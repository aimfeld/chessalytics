# Phase 216: Audit Bugs and Quick Wins - Context

**Gathered:** 2026-09-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Close the seven groups in SEED-161 (the 2026-09-04 quality-audit follow-up): the three
verified live production defects (real client IP behind Cloudflare, missing security
response headers, dead dependency automation), two CI/ops quick wins (CI dependency
caching, a `/api/health` that proves the database), the function-size gate with its eight
depth breaches fixed, and the housekeeping bundle (digest pins, rate-limiter eviction,
`.env.example` gaps, four hex literals, no-op downgrade docstrings + `compare_type`, one
orphan worktree). No product behavior change. Each group is independently shippable.

Work ends at squash-merge to `main`. The production deploy runs separately via `/deploy`;
verifying the client-IP fix and the response headers against flawchess.com is a
post-deploy HUMAN-UAT item, not a phase gate.

**Out of scope** (the seed's "Not in this seed" list): self-service account deletion +
data export (F-05/F-13), nightly `pg_dump` offsite + restore runbook (F-06/F-07), JWT
lifetime / refresh / denylist (F-04), `eval_remote.py` SQL into a repository (F-10),
retiring native PG enums (F-14), entry-chunk diet (F-15), structured logging + request-id
(F-11). Any major-version dependency bump (see D-05).

</domain>

<decisions>
## Implementation Decisions

### Dependency automation (seed group 3)
- **D-01:** Renovate stays the owner of version updates. Keep `renovate.json` as is; the
  fix is installing the Renovate GitHub App on `flawchess/flawchess`. That is a GitHub UI
  action the user performs (HUMAN-UAT). Do NOT add `.github/dependabot.yml` for version
  updates; Dependabot keeps doing security PRs only. The README "renovate enabled" badge
  (`README.md:18`) stays.
- **D-02:** No staleness guard. The Dependency Dashboard issue that the app opens on
  install is the visible signal that it is running. No CI step, no config validator.
- **D-03:** No automerge. Every Renovate PR is reviewed by hand, matching the local
  squash-merge workflow. Leave `prConcurrentLimit: 5`, `prHourlyLimit: 2` untouched.
- **D-04:** Manual in-range catch-up lands in this phase BEFORE the app install so
  Renovate starts from current: `npm update` in `frontend/` and `uv lock --upgrade` at the
  root, both only within the existing semver ranges. Run the full frontend + backend gate
  afterwards (including `npm run build`, since `npm test` does not type-check).
- **D-05:** Majors are NOT taken in this phase. Verified outstanding on 2026-09-04:
  `typescript` 6→7, `vitest` + `@vitest/coverage-v8` + `@vitest/ui` 4→5, `jsdom` 29→30,
  `@types/node` 24→26, `onnxruntime-web` 1.27→1.29 (also vendored under
  `frontend/public/maia/`, so the npm bump alone is meaningless), `anthropic` 0.122→1.3,
  `complexipy` 7→8. They arrive as one Renovate PR each after install and are reviewed
  there.

### Security headers and CSP (seed group 2)
- **D-06:** Ship HSTS `max-age=31536000; includeSubDomains` (no `preload`),
  `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, and a
  `Permissions-Policy` denying camera, microphone and geolocation, on the `flawchess.com`
  site block in `deploy/Caddyfile`. `analytics.flawchess.com` is on the same Caddy and
  already HTTPS, so `includeSubDomains` is safe. — **Reversibility:** costly —
  `includeSubDomains` is cached by browsers for a year; a future plain-HTTP subdomain would
  be unreachable until expiry.
- **D-07:** CSP ships as `Content-Security-Policy-Report-Only` with a `report-uri` (and
  `report-to`) pointing at the Sentry project's security-report endpoint
  (org `flawchess`, project id `4511084868272208`, region `de.sentry.io`). Violations become
  Sentry issues; nothing is enforced. Flipping to enforcing is a later, separate decision.
  The candidate policy must allow, at minimum: `script-src 'self' https://analytics.flawchess.com`
  (Umami), `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `font-src https://fonts.gstatic.com`, `connect-src 'self' https://*.ingest.de.sentry.io`,
  `worker-src 'self' blob:` and `'wasm-unsafe-eval'` for the Stockfish/Maia workers,
  `frame-ancestors 'none'`, `img-src 'self' data: blob:`. Google OAuth is a top-level
  redirect to accounts.google.com, not an iframe or GSI script, so it needs no allowance.
  The planner/researcher should confirm the list against `frontend/index.html` and the
  worker sources in `frontend/src/lib/engine/`.
- **D-08:** Do NOT add COOP or COEP headers (breaks Google OAuth and iOS Safari; the
  existing CI guard enforces this and stays).
- **D-09:** Header assertions live in two places. (a) A CI step runs `caddy validate` on
  `deploy/Caddyfile` so syntax errors fail pre-merge. (b) The deploy job's existing
  "Health check" step in `.github/workflows/ci.yml` is extended to `curl -I` flawchess.com
  after the health loop passes and fail on any missing header (HSTS, nosniff,
  Referrer-Policy, Permissions-Policy, CSP-Report-Only). The vite-preview COOP/COEP step
  cannot see Caddy headers and is not the place for this.

### Real client IP behind Cloudflare (seed group 1)
- **D-10:** Caddy global `servers { trusted_proxies static <ranges>; client_ip_headers Cf-Connecting-Ip }`
  with the Cloudflare IPv4 + IPv6 ranges inline in `deploy/Caddyfile`, preceded by a
  comment naming the source URLs (https://www.cloudflare.com/ips-v4 and /ips-v6). Stock
  `caddy:2.11.4` image, no xcaddy plugin build.
- **D-11:** A small `bin/` script fetches both range lists and diffs them against the
  Caddyfile block, exiting non-zero on drift, so the list can be refreshed on demand. Not
  wired into CI (a network call on every run is not worth it); document it in
  `docs/dev-tooling.md` and `docs/production-runbook.md`.
- **D-12:** Leave uvicorn's `--proxy-headers --forwarded-allow-ips='*'` in
  `deploy/entrypoint.sh` as is; it only ever sees Caddy on the Docker network, and Caddy
  now writes the real client IP into `X-Forwarded-For`.

### Function-size gate (seed group 6)
- **D-13:** Fix all eight depth breaches in this phase and land the gate clean. No
  baseline file, no depth pragma (Phase 214 decided the `allow-loc` pragma never covers
  depth; keep that). The eight, measured 2026-09-04:
  `app/routers/position_bookmarks.py:39 get_suggestions` (5),
  `app/services/chesscom_client.py:375 fetch_chesscom_games_backward` (5),
  `app/services/import_service.py:1010 _make_game_iterator` (5),
  `app/services/library_service.py:478 _build_card` (5),
  `app/services/lichess_client.py:51 fetch_lichess_games` (7),
  `app/services/openings_service.py:282 get_time_series` (5),
  `app/services/user_benchmark_percentiles_service.py:428 compute_stage_a` (6),
  `app/services/user_benchmark_percentiles_service.py:505 compute_stage_b` (7).
  Zero-behavior-change refactors: early `continue`/`return`, helper extraction along the
  seams CLAUDE.md names. Existing tests are the oracle; tests may be added, never rewritten
  to fit the refactor. Respect the "don't split just to fit a signature" rule.
- **D-14:** The gate runs as a new `ci.yml` step after ruff/ty
  (`uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200`)
  AND as a new line in the mandatory pre-merge gate block in `CLAUDE.md`. Scope is `app/`
  only; `tests/` and `scripts/` are not gated.

### Claude's Discretion
- **CI dependency caching (seed group 4):** `astral-sh/setup-uv` with `enable-cache: true`
  replacing the `pip install uv` step; `setup-node` with `cache: npm` and
  `cache-dependency-path: frontend/package-lock.json`. Record the median run time before
  and after in the plan summary.
- **`/api/health` (seed group 5):** one `SELECT 1` on a request session under a ~2 s
  timeout (named constant); 503 with the same `{"status": ...}` shape on failure so the
  deploy curl loop keeps working. Do not add an alembic-head check; that is a different
  question (a migrating container should fail the loop naturally because `entrypoint.sh`
  runs `alembic upgrade head` before uvicorn starts).
- **Housekeeping (seed group 7):** all six bullets as listed in the seed. Digest-pin both
  `frontend/Dockerfile` bases the way `Dockerfile` pins `python:3.13-slim`. Rate limiters
  (`app/core/ip_rate_limiter.py`, `feedback_rate_limiter.py`,
  `reset_password_rate_limiter.py`) `del` the key when its list is empty after pruning.
  Verify the "10 no-op downgrades" count before docstringing. The orphan worktree removal
  (`.claude/worktrees/agent-a740fb7ec554451f9`) is local-only, no commit, and is a
  HUMAN-UAT/manual step because it deletes files outside the repo tree.
- **Plan grouping:** one plan per seed group is the natural split (7 plans); groups 1-3
  first. The dependency catch-up (D-04) and the eight depth fixes (D-13) are the only
  plans that touch application code and each needs the full pre-merge gate.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source of the work
- `.planning/seeds/SEED-161-audit-2026-09-04-bugs-and-quick-wins.md` — the seven groups,
  file:line pointers, suggested fixes, and the explicit "not in this seed" list.
- `reports/quality-assessment/flawchess_quality_assessment_2026-09-04.md` §5 (Findings
  Register), §6, §8 — finding IDs F-01..F-21 with evidence.

### Infra and deploy
- `deploy/Caddyfile` — current site config; the global `log` filter block and the
  "drop ALL request headers" rationale must survive the edit (the CF trusted_proxies block
  goes in the same global block).
- `deploy/entrypoint.sh` — uvicorn proxy-header flags (unchanged, D-12).
- `.github/workflows/ci.yml` — COOP/COEP guard step (keep), deploy "Health check" step
  (extend, D-09), Python/Node setup steps (cache, discretion).
- `docs/production-runbook.md`, `docs/dev-tooling.md` — document the CF refresh script and
  the new gate command.
- `docs/git-workflow.md` — release flow; the phase ends at merge to `main`.

### Complexity gate
- `scripts/check_function_size.py` — the gate script; `allow-loc` pragma semantics
  (LOC only, never depth).
- `CLAUDE.md` "Coding Guidelines" and "Pre-merge gate" — nesting hard limit 4, the seams
  to split along, and the gate block that gains a line (D-14).
- `.planning/milestones/v2.15-ROADMAP.md` Phase 214/215 — precedent for
  zero-behavior-change decomposition with tests as oracle.

### Sentry
- CLAUDE.md "Error Handling & Sentry" — org/project/region identifiers needed for the CSP
  `report-uri` (D-07).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Dockerfile` already digest-pins `python:3.13-slim`; copy the pattern for the two
  `frontend/Dockerfile` bases.
- `app/core/ip_rate_limiter.py` `_SlidingWindowRateLimiter` is the template the other two
  limiters follow; the eviction fix is the same three lines in each.
- `ci.yml` "Health check" loop (36 × 5 s curl) is the hook for the post-deploy header
  assertion.

### Established Patterns
- `deploy/Caddyfile` documents every non-obvious directive with a "why" comment referencing
  the incident that motivated it. New blocks (trusted_proxies, headers, CSP) follow that
  style.
- Phase 214/215 decomposition style: split along named seams, tests untouched or added,
  per-file-ignores removed rather than extended.
- Time-dependent code takes `now_utc` from `dev_now_utc`; not relevant to the health check
  (no clock), but the timeout must be a named constant.

### Integration Points
- `app/main.py` `health_check` (line ~304) gains a DB round-trip via the existing session
  dependency.
- `app/routers/auth.py:313-318` guest-creation limiter and
  `app/models/worker_heartbeat.py` `last_ip` become correct as a side effect of D-10; no
  code change there.
- `README.md:18` Renovate badge stays (D-01).

</code_context>

<specifics>
## Specific Ideas

- Verification query for the client-IP fix after the next deploy (HUMAN-UAT):
  `SELECT last_ip, max(last_seen) FROM worker_heartbeats GROUP BY 1 ORDER BY 2 DESC LIMIT 5`
  on prod; rows must stop showing `162.158/104.23/172.71` addresses.
- Post-deploy header check: `curl -I https://flawchess.com/` must show all five headers
  from D-06/D-07 and must NOT show COOP/COEP.

</specifics>

<deferred>
## Deferred Ideas

- Major-version bumps (D-05 list) — handled by Renovate PRs after install; `typescript` 7
  and `onnxruntime-web` (needs re-vendoring under `frontend/public/maia/`) deserve their
  own quick tasks when the PRs arrive.
- Flipping CSP from report-only to enforcing — after a few weeks of Sentry violation data.
- The seed's "Not in this seed" list (F-04, F-05/F-13, F-06/F-07, F-10, F-11, F-14, F-15)
  — each needs its own phase.
- `gh api` currently fails with "A JSON web token could not be decoded" (HTTP 401) on this
  machine; unrelated to the phase but worth checking `GH_TOKEN` before the deploy.

</deferred>

---

*Phase: 216-audit-bugs-and-quick-wins*
*Context gathered: 2026-09-04*
