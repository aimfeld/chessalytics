---
id: SEED-161
status: active
planted: 2026-09-04
planted_during: /codebase-audit:report run at 9b099f57c (reports/quality-assessment/flawchess_quality_assessment_2026-09-04.md)
trigger_when: next /gsd-quick slot; items 1-3 are live production defects and should go first
scope: ops/config + small backend/CI edits; no product behavior change; each item is independently shippable and ≤1h except where noted
---

# SEED-161: 2026-09-04 audit — bugs and quick wins

Source: `reports/quality-assessment/flawchess_quality_assessment_2026-09-04.md` §5/§6/§8.
Finding IDs (F-xx) refer to that report. Suggested execution: one `/gsd-quick` per
numbered group below, in order; groups 1-3 first (verified live defects).

## 1. Real client IP behind Cloudflare (F-01, bug, ≈30 min)

Since the 2026-08-11 CDN cutover, `deploy/Caddyfile` has no `trusted_proxies`, so Caddy
forwards its immediate peer (a Cloudflare anycast IP) and uvicorn
(`deploy/entrypoint.sh:10`, `--proxy-headers --forwarded-allow-ips='*'`) exposes it as
`request.client.host`. Verified in prod: every `worker_heartbeats.last_ip` written after
2026-08-11 is in `162.158/104.23/172.71`; rows up to 2026-08-10 are real ISP/Hetzner IPs.

Effects: guest-creation limiter (`app/routers/auth.py:313-318`, 5/hour/IP,
`app/core/ip_rate_limiter.py:8-9`) buckets unrelated visitors on the same edge together;
`last_ip` (documented as the trustworthy fleet-identity cross-check,
`app/models/worker_heartbeat.py:17-19`) is meaningless.

Fix: Caddyfile global block
`servers { trusted_proxies static <Cloudflare IPv4+IPv6 ranges>; client_ip_headers Cf-Connecting-Ip }`
(Caddy ≥2.7; image is 2.11.4). Verify after deploy with
`SELECT last_ip, max(last_seen) FROM worker_heartbeats GROUP BY 1 ORDER BY 2 DESC LIMIT 5`
on prod. Consider a small script or comment noting where the CF range list comes from
(https://www.cloudflare.com/ips-v4 / ips-v6) so it can be refreshed.

## 2. Security response headers (F-02, ≈1 h)

`curl -I https://flawchess.com/` returns no HSTS, CSP, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`. All 6 `header` directives in `deploy/Caddyfile`
(`:100,105,112,128,141`) are `Cache-Control`.

Fix: one `header` block on the `flawchess.com` site:
`Strict-Transport-Security "max-age=31536000; includeSubDomains"`,
`X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`,
`Permissions-Policy` (deny camera/mic/geolocation), and CSP starting **report-only**
(`frame-ancestors 'none'` at minimum; full CSP needs `worker-src`/`wasm-unsafe-eval` for
the engine workers and Google OAuth allowances — do not ship enforcing CSP blind).
Extend the CI COOP/COEP guard step (`.github/workflows/ci.yml` "No COOP/COEP header
guard") to assert the new headers are present. Do NOT add COOP/COEP.

## 3. Dependency automation is dead (F-03, bug, ≈30 min)

`renovate.json` landed 2026-04-20 (commit 4c615ced0); `git log --all` has zero
Renovate-authored commits and `gh pr list --state all` has zero Renovate PRs. Only
Dependabot *security* PRs exist; there is no `.github/dependabot.yml` for version updates.
`npm outdated` shows 27 packages behind `wanted`.

Fix: either install the Renovate GitHub App on `flawchess/flawchess` (config is already
correct — HUMAN-UAT: needs a GitHub UI action), or delete `renovate.json` and add
`.github/dependabot.yml` covering `pip` (`/`), `npm` (`/frontend`), `github-actions`,
`docker`, weekly Monday, grouped minor+patch. Fix the README "renovate enabled" badge
(`README.md:19`) to match whichever is chosen.

## 4. CI dependency caching (F-08, ≈30 min)

`ci.yml:35` `setup-python@v6` has no `cache:`; uv is `pip install`ed fresh (`:39`);
`setup-node@v6` (`:125`) has no `cache: npm`. Median run 8 m 49 s.
Fix: `astral-sh/setup-uv` with `enable-cache: true` (drop the `pip install uv` step),
`setup-node` with `cache: npm` and `cache-dependency-path: frontend/package-lock.json`.
Expect 1-2 min saved per run.

## 5. `/api/health` must prove the DB (F-12, ≈30 min)

`app/main.py:304-306` returns `{"status": "ok"}` without a DB round-trip, so the deploy
health loop (`ci.yml:240-250`) passes while Postgres is down or still migrating.
Fix: `await session.execute(text("SELECT 1"))` under a ~2 s timeout; 503 on failure.
Keep the response shape for the existing curl loop.

## 6. Gate the function-size rule (F-09, ≈30 min gate; 1 d to fix breaches)

`uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200`
reports 8 breaches of the CLAUDE.md "hard 4" nesting limit, and the script runs in
neither `ci.yml` nor the pre-merge gate:
`position_bookmarks.py:39` (5), `chesscom_client.py:375` (5), `import_service.py:1010` (5),
`library_service.py:478` (5), `lichess_client.py:51` (**7**), `openings_service.py:282` (5),
`user_benchmark_percentiles_service.py:428` (6), `:505` (**7**).
Fix now: add the step to CI + the CLAUDE.md pre-merge gate with the 8 baselined (the
script supports pragmas — see `docs/dev-tooling.md`). Fix later: flatten the two depth-7
functions with early `continue`/`return`.

## 7. Housekeeping (F-16..F-21, ≈1 h total)

- Digest-pin `frontend/Dockerfile:1` (`node:24-alpine`) and `:13` (`caddy:2.11.4`) like
  the Python bases.
- Rate limiters never evict empty keys (`app/core/ip_rate_limiter.py`,
  `feedback_rate_limiter.py`, `reset_password_rate_limiter.py`): `del` the key when its
  timestamp list is empty after pruning.
- Add the 4 `Settings` fields missing from `.env.example` (commented out):
  `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`, `BENCHMARK_SELECTION_GATE_ENABLED`,
  `BEST_MOVE_BACKFILL_ENABLED`, `OAUTH_TUNNEL_ORIGINS`.
- Replace the 4 hex literals outside `theme.ts`: `Home.tsx:410,436,437`,
  `MaiaMoveQualityBar.tsx:566` (`#1a1a1a` / `#ffffff`).
- Docstring the 10 no-op `downgrade()` migrations as deliberately irreversible; set
  `compare_type=True` in `alembic/env.py`.
- `rm -rf .claude/worktrees/agent-a740fb7ec554451f9` (97 MB orphan, not in
  `git worktree list`) — local only, no commit.

## Not in this seed (bigger, need their own phase)

- F-05/F-13 self-service account deletion + data export (half-day each; plumbing exists in
  `guest_cleanup_service.py:64-117`).
- F-06/F-07 nightly `pg_dump` offsite + restore runbook with a dry run (half-day).
- F-04 JWT lifetime / refresh / denylist (>1 d; do after item 2).
- F-10 `eval_remote.py` SQL into a repository; F-14 retire native PG enums; F-15 entry-chunk
  diet; F-11 structured logging + request-id.
