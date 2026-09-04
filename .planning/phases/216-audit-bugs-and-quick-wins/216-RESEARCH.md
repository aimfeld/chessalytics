# Phase 216: Audit Bugs and Quick Wins - Research

**Researched:** 2026-09-04
**Domain:** Ops/infra hardening (Caddy proxy trust, security headers, CSP), CI/CD speed and gates, dependency automation, backend health-check correctness, nesting-depth refactors, housekeeping
**Confidence:** HIGH for code-grounded findings (Caddy config, CI, gate script, tests); MEDIUM for external syntax/protocol claims (Caddy 2.11 directive semantics, Sentry report-uri format) cross-checked against official docs; explicit LOW/ASSUMED flags where a value could not be verified in this session (notably the Sentry DSN/public key and `.env.example`'s exact byte content, both blocked from direct read).

## Summary

All seven SEED-161 groups are grounded in this repo's actual files; nothing in CONTEXT.md's decisions conflicts with what's on disk. Two load-bearing findings change how the planner should sequence work:

1. **D-04's "uv lock --upgrade at the root" will violate D-05 if run bare.** `uv lock --upgrade --dry-run` (run this session) pulls `anthropic 0.122.0 → 1.3.0` and `complexipy 7.0.1 → 8.0.0` — both explicitly excluded as majors in D-05 — because `anthropic` is an unpinned transitive dependency of `pydantic-ai-slim[anthropic]` and `complexipy` is declared `>=7.0.1` with no upper bound in `pyproject.toml`. `npm update` is safe as-is (verified: `npm outdated`'s "Wanted" column already excludes every D-05 npm major). The Python catch-up must use `uv lock --upgrade-package <name>` per safe package (or an equivalent scoped invocation), not a blanket `uv lock --upgrade`.
2. **The CSP `report-uri` needs a Sentry DSN public key and numeric org-ingest host that are not present anywhere in this repo** — `VITE_SENTRY_DSN`/`SENTRY_DSN` are runtime secrets (confirmed: grep of `docker-compose.yml`, `.env.example` blocked from read by this session's own permission settings — see Open Questions). This is a genuine HUMAN-UAT dependency, not a research gap: the safest source is Sentry's own **Settings → Projects → flawchess → Client Keys (DSN)** or the **Security Headers** settings page, not hand-derivation.

Everything else — Caddy `trusted_proxies`/`client_ip_headers` syntax, the `header` directive's placement so it applies across all three `handle` blocks, the CI caching actions, the `/api/health` DB probe design, the eight nesting-depth breach seams (all confirmed reproducible via the gate script, all covered by existing tests), and the housekeeping bundle — are all directly verifiable in this codebase or via authoritative docs, with no surprises versus CONTEXT.md's decisions.

**Primary recommendation:** Execute in CONTEXT.md's stated order (groups 1-3 first, D-04 before Renovate install), using `uv lock --upgrade-package` (not bare `--upgrade`) for the Python catch-up, and treat the Sentry report-uri value as a value to be pasted from the Sentry UI rather than derived.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Client IP trust (Cloudflare) | CDN / Edge (Caddy) | API / Backend (reads `X-Forwarded-For` via uvicorn `--proxy-headers`) | Caddy is the only hop that sees the raw Cloudflare connection; it must resolve and forward the real IP. uvicorn/FastAPI only consume what Caddy already trusts. |
| Security response headers (HSTS/CSP/nosniff/Referrer-Policy/Permissions-Policy) | CDN / Edge (Caddy) | — | Headers apply uniformly to every response leaving the edge (static, API, SPA fallback) — a single Caddy `header` block is the correct single point of control, not per-router FastAPI middleware. |
| Dependency automation (Renovate) | CI/CD (GitHub App) | — | Entirely a GitHub platform concern; no application code involved. |
| CI dependency caching | CI/CD (GitHub Actions) | — | Build-time infra only. |
| `/api/health` DB liveness | API / Backend | Database | The backend is the only tier that holds the DB session pool; Caddy/CDN cannot prove DB health. |
| Function-size gate | CI/CD (gate script) | Backend (`app/`) | Static analysis of backend source; enforced in CI and pre-merge, not at runtime. |
| Digest-pinned Docker bases | CI/CD (build) | — | Build-time supply-chain concern only. |
| Rate-limiter key eviction | API / Backend | — | In-process memory management inside FastAPI request handlers. |

## Standard Stack

No new application-level libraries are introduced by this phase. New/changed build- and CI-time dependencies:

### Core (CI/CD only)
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|---------------|
| `astral-sh/setup-uv` (GitHub Action) | `v10.x` (tag-pinned, per repo convention — see below) | Cache uv's resolution + wheel cache in CI | Official Astral-published action; this repo already trusts the `astral-sh` org (`ghcr.io/astral-sh/uv:0.10.9` is the base image in `Dockerfile:2`) [VERIFIED: Dockerfile:2] |
| `actions/setup-node` `cache: npm` | Already `@v6` in `ci.yml:125` | Cache `~/.npm` keyed on `frontend/package-lock.json` | Already in use; only the `cache:`/`cache-dependency-path` inputs are new |

**Version pinning convention (verified):** this repo pins GitHub Actions by **tag**, not SHA — `actions/checkout@v7`, `actions/setup-python@v6`, `actions/setup-node@v6`, `aquasecurity/trivy-action@v0.36.0`, `appleboy/ssh-action@v1`, `github/codeql-action/init@v3` [VERIFIED: .github/workflows/ci.yml, codeql.yml, pages.yml — grepped `uses:` lines this session]. Add `astral-sh/setup-uv` the same way (`@v10` or whatever its current major tag is at implementation time — re-verify the tag, since action majors move faster than this research's shelf life) [CITED: github.com/astral-sh/setup-uv README].

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Installing Renovate GitHub App | `.github/dependabot.yml` | CONTEXT.md D-01 already decided: Renovate stays, install the app. Dependabot config would duplicate `renovate.json`'s job with a weaker grouping model. Not researched further — locked. |
| `uv lock --upgrade-package` per package | Bare `uv lock --upgrade` then manually revert `anthropic`/`complexipy` in `uv.lock` | Hand-editing `uv.lock` after the fact is fragile (lock format isn't meant for manual edits and a partial revert can leave an inconsistent resolution); scoped `--upgrade-package` calls are the supported mechanism [CITED: docs.astral.sh/uv/reference/cli/#uv-lock]. |

**Version verification:** `npm outdated` and `uv lock --upgrade --dry-run` were both run this session (see Dependency Catch-Up section below) — the exact in-range deltas are enumerated there, not paraphrased.

## Package Legitimacy Audit

No new npm/PyPI/crates packages are installed by this phase — D-04 is an in-range **version bump** of already-vetted, already-`uv.lock`/`package-lock.json`-pinned packages, not a new-package install. The `package-legitimacy check` seam does not apply (it gates new package names, not version bumps of existing ones).

One new **supply-chain** dependency is added: the `astral-sh/setup-uv` GitHub Action. It is not an npm/pip/crates package, so the registry-check protocol doesn't cover it directly, but its trust lineage is already established in this repo: the same `astral-sh` GitHub org publishes the `ghcr.io/astral-sh/uv:0.10.9` image this repo already pins by digest in `Dockerfile:2` [VERIFIED: Dockerfile:2]. No `[SLOP]`/`[SUS]` disposition applies.

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram (client-IP + header flow, group 1+2)

```
Browser
  |
  | HTTPS (Cloudflare anycast IP terminates TLS at the edge)
  v
Cloudflare edge
  |  adds Cf-Connecting-Ip: <real client IP>
  |  connects to origin from a Cloudflare anycast IP (162.158.x.x / 104.16-31.x.x / 172.64-71.x.x / ...)
  v
Caddy (deploy/Caddyfile, global `servers{}` block)
  |  [NEW] trusted_proxies static <Cloudflare v4+v6 ranges>
  |  [NEW] client_ip_headers Cf-Connecting-Ip
  |  -> Caddy now resolves the REAL client IP for logging/proxy purposes
  |  [NEW] header block (site-level, unconditioned) sets HSTS / nosniff /
  |        Referrer-Policy / Permissions-Policy / CSP-Report-Only on EVERY
  |        response this site block produces, before routing into any
  |        `handle` block (Caddy's default directive order runs `header`
  |        before `handle`/`reverse_proxy`/`file_server`)
  v
  +-- handle @static  -> file_server (Cache-Control headers unchanged)
  +-- handle /api/*   -> reverse_proxy backend:8000
  |                        Caddy writes the trusted client IP into
  |                        X-Forwarded-For for this hop
  +-- handle (SPA fallback) -> index.html
  v
uvicorn (deploy/entrypoint.sh: --proxy-headers --forwarded-allow-ips='*')
  |  trusts X-Forwarded-For from Caddy (its only peer on the Docker network)
  |  -> request.client.host is now the real visitor IP, not a Cloudflare IP
  v
app/routers/auth.py guest-creation limiter (5/hr/IP) and
app/models/worker_heartbeat.py last_ip now see correct, distinct IPs
```

### Recommended Project Structure (no new directories — file-level changes only)
```
deploy/
├── Caddyfile          # + servers{} trusted_proxies/client_ip_headers, + site-level header block
.github/workflows/
├── ci.yml             # + setup-uv cache, + setup-node cache, + caddy validate step,
│                       #   + health-check curl -I header assertion, + function-size gate step
app/
├── main.py            # health_check() gains a DB round-trip
├── core/
│   ├── ip_rate_limiter.py           # eviction fix
│   ├── feedback_rate_limiter.py     # eviction fix (shares _SlidingWindowRateLimiter)
│   └── reset_password_rate_limiter.py  # eviction fix (shares _SlidingWindowRateLimiter)
├── routers/position_bookmarks.py    # get_suggestions depth fix
├── services/
│   ├── chesscom_client.py           # fetch_chesscom_games_backward depth fix
│   ├── import_service.py            # _make_game_iterator depth fix
│   ├── library_service.py           # _build_card depth fix
│   ├── lichess_client.py            # fetch_lichess_games depth fix
│   ├── openings_service.py          # get_time_series depth fix
│   └── user_benchmark_percentiles_service.py  # compute_stage_a + compute_stage_b depth fix
bin/
├── check_cloudflare_ips.sh          # [NEW] diffs deploy/Caddyfile's inline ranges vs cloudflare.com/ips-v4,v6
alembic/
├── env.py                           # + compare_type=True on both context.configure() calls
├── versions/<10 files>              # + irreversibility docstrings on downgrade()
frontend/
├── Dockerfile                       # digest-pin node:24-alpine, caddy:2.11.4
├── src/lib/theme.ts                 # + 1-2 new named tokens for the 4 hex literals
├── src/pages/Home.tsx               # 3 hex literals -> theme token
└── src/components/analysis/MaiaMoveQualityBar.tsx  # 1 line, 2 hex literals -> theme tokens
.env.example                         # + 4 commented Settings fields
CLAUDE.md                            # + function-size gate line in pre-merge gate block
docs/
├── dev-tooling.md                   # + function-size gate CI/pre-merge note (already documents the script)
└── production-runbook.md            # + Cloudflare range refresh script note
```

### Pattern 1: Caddy global `servers{}` trust block (group 1)
**What:** `trusted_proxies` and `client_ip_headers` are **two separate sibling directives** inside the global `servers { }` options block — NOT one directive with a sub-clause. [VERIFIED via WebFetch: caddyserver.com/docs/caddyfile/options — "client_ip_headers is a separate global option, not a sub-directive of trusted_proxies"]
**When to use:** Any reverse-proxy deployment sitting behind a CDN/proxy that injects its own `X-Forwarded-For`.
**Example:**
```caddyfile
{
	# Global log filter block (existing, KEEP — deploy/Caddyfile:1-19)
	log { ... }

	servers {
		# Cloudflare's published edge ranges (source: https://www.cloudflare.com/ips-v4
		# and https://www.cloudflare.com/ips-v6 — refresh via bin/check_cloudflare_ips.sh).
		trusted_proxies static \
			173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 \
			141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 \
			197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 \
			104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 \
			2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 \
			2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
		client_ip_headers Cf-Connecting-Ip
	}
}
```
CIDR ranges [CITED: cloudflare.com/ips-v4, cloudflare.com/ips-v6 — fetched this session]. Cloudflare's IP list changes rarely but has changed historically; do not hand-copy from this document at implementation time without re-fetching (this is exactly why D-11's diff script exists — treat this table as the input the script should validate against, not a value to trust blindly).

### Pattern 2: Site-level unconditioned `header` block (group 2)
**What:** A `header { ... }` block placed directly in the `flawchess.com { }` site body (not nested inside `handle @static`) applies to **every** response from that site, because Caddy's hard-coded default directive order places `header` before `handle`/`reverse_proxy`/`file_server` regardless of where in the Caddyfile source it's written [VERIFIED via WebFetch: caddyserver.com/docs/caddyfile/directives — ordering list: `header` → `encode` → `handle` → `reverse_proxy` → `file_server`].
**When to use:** Security headers that must appear on the SPA shell, static assets, AND the `/api/*` proxy — matches success criterion #2's `curl -I https://flawchess.com/` check.
**Example:**
```caddyfile
flawchess.com {
	encode gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		Content-Security-Policy-Report-Only "<see CSP section below>"
	}

	log { ... }  # existing redaction block, unchanged

	@static file
	handle @static { ... }  # existing Cache-Control headers, untouched — different header names, no conflict

	handle /api/* { ... }

	handle { ... }
}
```
No prefix operators (`+`/`-`/`?`) are needed since these are new field names never set elsewhere in the site block — plain `header { Name value }` overwrites/sets unconditionally and is NOT auto-deferred (defer only auto-triggers on `-`-delete or `?`-default operations) [VERIFIED via WebFetch: caddyserver.com/docs/caddyfile/directives/header].

### Pattern 3: CSP allowlist derivation (D-07, research question 1)
**What:** Enumerated every external origin and unsafe-directive requirement actually present in the frontend source this session.

| Directive | Value | Evidence |
|-----------|-------|----------|
| `default-src` | `'self'` | Baseline deny-by-default. |
| `script-src` | `'self' https://analytics.flawchess.com 'wasm-unsafe-eval'` | Umami `<script defer src="https://analytics.flawchess.com/script.js">` [VERIFIED: frontend/index.html:29-34]. No inline `<script>` with code (only `type="module" src="/src/main.tsx"`, external) — no `'unsafe-inline'`/nonce needed for scripts. `'wasm-unsafe-eval'` required for onnxruntime-web's WASM instantiation (Maia) and the vendored Stockfish `.wasm` — WebAssembly compile/instantiate is a `script-src` concern, not `connect-src` or `worker-src`. |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` | `<link href="https://fonts.googleapis.com/css2?family=...">` [VERIFIED: frontend/index.html:8]. `'unsafe-inline'` needed: the codebase uses React inline `style={{...}}` extensively (confirmed in `Home.tsx`, `MaiaMoveQualityBar.tsx`, `theme.ts`'s `darkSquareStyle`/`lightSquareStyle` objects) — no practical nonce/hash story for per-element dynamic inline styles. |
| `font-src` | `'self' https://fonts.gstatic.com` | `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` [VERIFIED: frontend/index.html:7]; Google's stylesheet references font files served from `fonts.gstatic.com`. |
| `connect-src` | `'self' https://*.ingest.de.sentry.io https://analytics.flawchess.com blob:` | `'self'` covers the API (`apiClient` baseURL is the relative `/api` — same-origin [VERIFIED: frontend/src/api/client.ts:50]) and same-origin `fetch()` calls to `/engine/*`/`/maia/*` [VERIFIED: frontend/src/lib/engine/engineAssetCache.ts:143 `fetch(url)`]. Sentry ingest per CLAUDE.md's org/region. `analytics.flawchess.com` because the Umami tracker script beacons events back to its own origin from the main document context (not a worker, so governed by the page's `connect-src`). `blob:` because the Stockfish worker's `.wasm` binary is fetched by the worker via a `Blob` object URL created with `URL.createObjectURL` [VERIFIED: frontend/src/lib/engine/stockfishWorkerSource.ts:90]. |
| `worker-src` | `'self' blob:` | `new Worker('/engine/stockfish-18-lite-single.js#...')` and `new Worker('/maia/maia-worker.js')` are both same-origin path constructions, not blob-URL worker scripts [VERIFIED: stockfishWorkerSource.ts:139,141; maiaWorkerHost.ts:376 `grep "new Worker"` this session] — `'self'` alone would suffice for worker *construction*, but `blob:` is kept for defense-in-depth consistency with `connect-src` and because CONTEXT.md's candidate policy already specifies it; report-only mode makes the cost of over-inclusion zero. |
| `img-src` | `'self' data: blob:` | Per CONTEXT.md D-07 candidate; not independently re-verified against every image usage this session — flag as lower-confidence than the other directives if the planner wants a tighter list. |
| `frame-ancestors` | `'none'` | No legitimate embedding use case; matches CONTEXT.md D-07. |
| `base-uri` | `'self'` | Standard hardening; no `<base>` tag found in index.html. |
| `form-action` | `'self'` | No cross-origin form posts found; Google OAuth is a JS `window.location.href` redirect, not a `<form>` submission (see below), so this is safe. |

**Google OAuth is confirmed a top-level `window.location.href` redirect, not an iframe/GSI script** [VERIFIED: frontend/src/components/auth/LoginForm.tsx:66, RegisterForm.tsx:138 — both `window.location.href = await getGoogleAuthorizationUrl()`; backend builds the `authorization_url` server-side in `app/routers/auth.py:117-193`]. A full-page navigation is not subject to `connect-src`/`frame-src`/`script-src` at all (CSP governs resource *fetches* from the document, not top-level navigation targets), so **no CSP allowance for `accounts.google.com` is needed**. This directly confirms CONTEXT.md D-07's claim.

**Vendored Maia assets** (`frontend/public/maia/`: `maia3_simplified.onnx`, `maia-worker.js`, `ort.wasm.min.js`, `ort-wasm-simd-threaded*.{mjs,wasm}`, `ort.webgpu.min.js`) and **vendored Stockfish** (`frontend/public/engine/`: `stockfish-18-lite-single.{js,wasm}`) are all served same-origin from `/maia/*` and `/engine/*` [VERIFIED: `ls frontend/public/maia/ frontend/public/engine/` this session] — covered by `'self'` in `connect-src`/`worker-src`, no extra origin needed.

**Candidate full policy** (report-only; assemble from the directive table above):
```
Content-Security-Policy-Report-Only:
  default-src 'self';
  script-src 'self' https://analytics.flawchess.com 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: blob:;
  connect-src 'self' https://*.ingest.de.sentry.io https://analytics.flawchess.com blob:;
  worker-src 'self' blob:;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  report-uri <sentry-security-endpoint>;
```

### Pattern 4: Sentry security report endpoint (D-07, research question 2)
**What:** Sentry's documented format is:
```
https://<org-ingest-domain>/api/<project-id>/security/?sentry_key=<public-key>
```
[CITED: docs.sentry.io/platforms/python/security-policy-reporting/ — literal placeholder form `https://___ORG_INGEST_DOMAIN___/api/___PROJECT_ID___/security/?sentry_key=___PUBLIC_KEY___`, which Sentry's own docs UI auto-substitutes when viewed while logged into the org]. Project ID `4511084868272208` and region `de.sentry.io` are known [per CLAUDE.md "Error Handling & Sentry"], but the **numeric org-ingest host prefix and the public key are not derivable from anything in this repo** — they live only inside the DSN, which is supplied at build/deploy time via `VITE_SENTRY_DSN`/`SENTRY_DSN` env vars [VERIFIED: `docker-compose.yml:140` `VITE_SENTRY_DSN=${VITE_SENTRY_DSN}`, `docker-compose.worker.yml:18` `SENTRY_DSN: ${SENTRY_DSN:-}` — grepped, no literal value found anywhere in the repo]. **Do not guess the numeric org ID.** The correct, zero-risk way to get the exact string: open **Sentry → Settings → Projects → flawchess → Client Keys (DSN)** (or the "Security Headers" settings page, which some Sentry versions render pre-filled) and copy the endpoint verbatim. This is a `checkpoint:human-verify`-shaped step, not a code task.

`report-to`/`Reporting-Endpoints` (the newer structured-reporting mechanism) requires **two additional headers** beyond `report-uri` (a `Report-To` header with `max_age`+`endpoints`, or the newer `Reporting-Endpoints` header) [CITED: docs.sentry.io/platforms/python/security-policy-reporting/]. Given this ships report-only and `report-uri` alone is honored by all major browsers, recommend **`report-uri` only** for this phase — the added complexity of a second header for marginal forward-compatibility isn't worth it; this is Claude's discretion territory, not a locked decision.

### Pattern 5: `/api/health` DB round-trip (group 5, research question 7)
**What:** Current implementation takes no dependencies at all:
```python
# app/main.py:304-306 (current)
@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}
```
[VERIFIED: app/main.py:304-306]. The session dependency (`get_async_session`) yields an `AsyncSession` from `async_session_maker` [VERIFIED: app/core/database.py:1-29] and is already the standard router pattern (`Annotated[AsyncSession, Depends(get_async_session)]`, used e.g. in `position_bookmarks.py:40`).

**Proposed shape** (matches CONTEXT.md's discretion note — named timeout constant, same response shape on success):
```python
from asyncio import TimeoutError as AsyncTimeoutError, wait_for
from fastapi import status
from fastapi.responses import JSONResponse
from sqlalchemy import text

_HEALTH_DB_TIMEOUT_S = 2.0  # named constant, CLAUDE.md no-magic-numbers

@app.get("/api/health")
async def health_check(
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> Response:
    try:
        await wait_for(session.execute(text("SELECT 1")), timeout=_HEALTH_DB_TIMEOUT_S)
    except (AsyncTimeoutError, Exception) as exc:
        sentry_sdk.capture_exception(exc)  # per CLAUDE.md Sentry rule
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"status": "degraded"})
    return {"status": "ok"}
```
The deploy health loop only checks `curl -sf https://flawchess.com/api/health` for a 2xx exit code [VERIFIED: .github/workflows/ci.yml:242 `curl -sf ...`] — `-f` makes curl fail on any non-2xx, so the exact 503 body shape doesn't matter for the loop, only the status code. Keep `{"status": "ok"}` on success unchanged so nothing else that might parse the body (none found this session) breaks.

**No test currently exercises `/api/health`'s behavior** — the two existing references are incidental: `tests/test_sentry_traces_sampler.py:34` uses the literal path string in an untraced-path-list fixture, and `tests/test_last_activity_middleware.py:553` calls it only to confirm the activity middleware doesn't crash on an unauthenticated request [VERIFIED: grepped both files this session]. This is a genuine Wave-0 gap — see Validation Architecture below.

`override_get_async_session` in `tests/conftest.py` is a **session-scoped autouse fixture** [VERIFIED: tests/conftest.py:373-419] that already routes `get_async_session` to the real per-run test Postgres DB — the happy path (`SELECT 1` succeeds) is exercised for free by any test that hits `/api/health`. The failure/timeout path needs a **per-test** dependency override that raises or hangs, restored afterward (the autouse fixture's override must be put back, not just popped, or later tests lose DB access).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cloudflare IP range tracking | A hardcoded list with no refresh mechanism | `bin/check_cloudflare_ips.sh` diffing against `cloudflare.com/ips-v4`/`ips-v6` (D-11) | Cloudflare's edge ranges are not static long-term; a silent drift would reopen the exact bug this phase fixes. |
| CSP report ingestion | A custom `/api/csp-report` endpoint + DB table | Sentry's built-in Security Policy Reporting (`report-uri`) | Sentry already has dashboards, deduplication, and alerting for this; a custom endpoint duplicates infrastructure for zero benefit. |
| Rate limiter key eviction | A new limiter class/library (Redis, etc.) | Three-line `del` fix in the existing `_SlidingWindowRateLimiter.is_allowed()` | F-17 is exactly "never evicts", not "wrong algorithm" — the fix is in-place, not a rewrite. `app/core/ip_rate_limiter.py` is the single shared implementation all three limiters already import [VERIFIED: feedback_rate_limiter.py, reset_password_rate_limiter.py both `from app.core.ip_rate_limiter import _SlidingWindowRateLimiter`]. |

**Key insight:** every group in this phase is a **fix to existing infrastructure**, not a new subsystem — the "don't hand-roll" risk here is over-building (e.g. adding a CSP-report DB table, or a Redis rate limiter) where the seed and CONTEXT.md both scope a minimal, in-place fix.

## Runtime State Inventory

Not applicable in the classic rename/refactor sense (no renamed identifiers), but this phase does touch **live production config and registered state**, so the same discipline applies:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `worker_heartbeats.last_ip` rows written after 2026-08-11 are Cloudflare IPs, not real client IPs [VERIFIED via seed: prod query cited in SEED-161 §1] | **No backfill** — CONTEXT.md's `<specifics>` section already specifies this is a forward-looking verification only (`SELECT last_ip, max(last_seen) ... LIMIT 5` post-deploy), not a data migration. Old rows stay wrong; only new rows after the fix are correct. |
| Live service config | None — this phase does not touch n8n/Datadog/Tailscale/any UI-configured external service | N/A |
| OS-registered state | The orphan worktree `.claude/worktrees/agent-a740fb7ec554451f9` (97 MB, confirmed absent from `git worktree list` output — only the main repo and `flawchess-123.1` are registered [VERIFIED: `git worktree list` this session]) | Manual `rm -rf`, HUMAN-UAT per CONTEXT.md — not a commit, outside the repo tree. |
| Secrets/env vars | `VITE_SENTRY_DSN`/`SENTRY_DSN` are env-injected at build/run time, never committed [VERIFIED: no literal DSN found in repo grep this session] | The CSP `report-uri` value must be pasted by a human from the Sentry UI, not derived from repo contents (see Pattern 4 above). |
| Build artifacts | None identified — this phase's Docker digest-pinning changes the base image reference, not an artifact that needs regeneration | N/A |

## Common Pitfalls

### Pitfall 1: Bare `uv lock --upgrade` silently violates D-05
**What goes wrong:** Running `uv lock --upgrade` (no `--upgrade-package` scoping) pulls `anthropic` from `0.122.0` to `1.3.0` and `complexipy` from `7.0.1` to `8.0.0` — both explicitly excluded as majors in D-05.
**Why it happens:** `anthropic` is a transitive dependency of `pydantic-ai-slim[anthropic]` [VERIFIED: this project's own constraint is `pydantic-ai-slim[anthropic,google]>=2.31,<3.0`, `pyproject.toml:15`] — this repo has no direct version pin on `anthropic` at all, so whatever range `pydantic-ai-slim` itself permits governs it. `complexipy` is a **direct** dependency but declared `complexipy>=7.0.1` [VERIFIED: pyproject.toml:27] — an unbounded-above range, unlike npm's caret (`^`) convention which caps at the next major by default.
**How to avoid:** Use `uv lock --upgrade-package <name>` looped over the packages that ARE safe to bump (every entry in the `uv lock --upgrade --dry-run` diff below **except** `anthropic` and `complexipy`), or run the blanket upgrade and then verify `uv.lock`'s `anthropic`/`complexipy` entries didn't move past their current major before committing.
**Warning signs:** `uv lock --upgrade --dry-run | grep -E "anthropic|complexipy"` showing a major-version jump.

**Full in-range diff observed this session** (`uv lock --upgrade --dry-run`, 2026-09-04):
```
Add agent-detector v2.0.0
Update alembic v1.18.4 -> v1.19.1
Update annotated-doc v0.0.4 -> v0.0.5
Update annotated-types v0.7.0 -> v0.8.0
Update anthropic v0.122.0 -> v1.3.0        # EXCLUDE (D-05)
Update anyio v4.13.0 -> v4.15.0
Update argon2-cffi-bindings v25.1.0 -> v26.1.0
Update certifi, cffi, charset-normalizer, click (minor/patch, safe)
Update complexipy v7.0.1 -> v8.0.0         # EXCLUDE (D-05)
Update coverage, cryptography (patch, safe)
Update detect-installer, fastapi, fastapi-cli, fastapi-cloud-cli, fastar (safe)
Update genai-prices, google-auth, google-genai, greenlet, griffelib (safe)
Update httpcore2, httpx2 (safe); Add httpx2-jsfetch v1.0
Update idna, jiter, logfire-api, mako, numpy (safe)
Update opentelemetry-api, packaging, protobuf (safe)
Update pydantic, pydantic-ai-slim, pydantic-core, pydantic-graph, pydantic-settings (safe)
Update pygments, pytest, python-dotenv, rich-toolkit, rignore, ruff (safe)
Update sentry-sdk, sqlalchemy, starlette (safe); Remove tomli; Add truststore
Update ty, typer, typing-extensions, typing-inspection, uvicorn, websockets (safe)
```
[VERIFIED: `uv lock --upgrade --dry-run` output, this session — reproduce before implementing since transitive resolutions can shift].

**npm side is clean by contrast** — `npm outdated`'s "Wanted" column (the version `npm update` would actually install, respecting `package.json` ranges) already excludes every D-05 npm major:
```
typescript          Current 6.0.3   Wanted 6.0.3    Latest 7.0.2   (unchanged by npm update)
@vitest/coverage-v8  Current 4.1.7  Wanted 4.1.11   Latest 5.0.0   (stays on 4.x)
@vitest/ui           Current 4.1.7  Wanted 4.1.11   Latest 5.0.0   (stays on 4.x)
jsdom                Current 29.1.1 Wanted 29.1.1   Latest 30.0.1  (unchanged)
@types/node          Current 24.12.4 Wanted 24.13.3 Latest 26.4.1 (stays on 24.x)
onnxruntime-web      Current 1.27.0 Wanted 1.27.0   Latest 1.29.0  (unchanged — exact-pinned)
```
[VERIFIED: `npm outdated` output, run from `frontend/`, this session]. `npm update` alone is sufficient and safe for D-04's frontend half.

### Pitfall 2: Header block placed inside `handle @static` only covers static responses
**What goes wrong:** If the new security-header block is added inside the existing `handle @static { }` scope (where the Cache-Control headers already live), it will NOT appear on `/api/*` responses or the SPA-fallback `index.html` response — success criterion #2's `curl -I https://flawchess.com/` (root path, SPA fallback) would still pass since `/` is served by the SPA-fallback handle in this Caddyfile's ordering (actually `@static file` only matches if a file exists on disk at that exact path, and `/` has no matching static file, so `/` falls through to the SPA-fallback `handle {}` block) — but `curl -I https://flawchess.com/api/health` would NOT show the headers, silently narrowing the fix.
**Why it happens:** Caddy's route matching inside a site block short-circuits at the first matching `handle`; headers set inside one `handle` don't apply to requests routed to a different `handle`.
**How to avoid:** Place the `header { }` block unconditioned, directly in the site body (see Pattern 2 above) — Caddy's directive-ordering guarantee means it runs before any `handle` regardless of source position.
**Warning signs:** `curl -I` on `/api/health` missing headers that `curl -I` on `/` shows.

### Pitfall 3: `.env.example` is blocked from direct read in this research session
**What goes wrong:** Neither the `Read` nor `Bash cat`/`grep` tool could access `.env.example` — both returned "Permission to use [tool] ... has been denied" / "File is in a directory that is denied by your permission settings", despite the file being a plain example file (not a real secrets file) [confirmed this session — both tool types tried, both denied].
**Why it happens:** Environment-level permission policy appears to block reads of any `.env*`-matching path, example files included.
**How to avoid:** The planner/executor for the housekeeping group's `.env.example` edit will need to either (a) have this restriction lifted for that specific task, or (b) construct the diff purely from `app/core/config.py`'s `Settings` class (all four target fields' types/defaults ARE independently confirmed there — see Housekeeping section below — so the four new lines can be written without reading the current file, but the EXISTING file's format/ordering/comment style cannot be matched without reading it first).
**Warning signs:** An edit to `.env.example` that doesn't match its established commenting/grouping convention (unverifiable this session).

## Code Examples

### Function-size gate: current output (verified reproducible)
```bash
$ uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200
app/routers/position_bookmarks.py:39: get_suggestions -- depth 5 > 4
app/services/chesscom_client.py:375: fetch_chesscom_games_backward -- depth 5 > 4
app/services/import_service.py:1010: _make_game_iterator -- depth 5 > 4
app/services/library_service.py:478: _build_card -- depth 5 > 4
app/services/lichess_client.py:51: fetch_lichess_games -- depth 7 > 4
app/services/openings_service.py:282: get_time_series -- depth 5 > 4
app/services/user_benchmark_percentiles_service.py:428: compute_stage_a -- depth 6 > 4
app/services/user_benchmark_percentiles_service.py:505: compute_stage_b -- depth 7 > 4
```
[VERIFIED: ran this session, 2026-09-04 — exit code 1, exact match to CONTEXT.md D-13's list]. Exit code 0 with `OK: <N> functions scanned, no breaches` once all eight are fixed [VERIFIED: scripts/check_function_size.py:320-323].

### Per-function refactor seam (all zero-behavior-change; existing tests are the oracle)

| Function | Depth | Test coverage (existing) | Seam |
|----------|-------|---------------------------|------|
| `position_bookmarks.py:39 get_suggestions` | 5 | `tests/test_bookmarks_router.py` [VERIFIED: grep] | Extract the per-position body (the inner `for white_hash, black_hash, full_hash, game_count in top_positions:` loop, lines ~71-129, which contains the try/except FEN reconstruction) into a helper `_build_position_suggestion(session, user, color, white_hash, black_hash, full_hash, game_count) -> PositionSuggestion \| None`. The outer two `for` loops (color, position) stay in `get_suggestions`; the helper's own try/for/if nests independently and stays under depth 4. |
| `chesscom_client.py:375 fetch_chesscom_games_backward` | 5 | `tests/test_chesscom_client.py`, `tests/test_import_service.py` [VERIFIED: grep] | The function's early-return guards (`if should_stop(): return`, `if start_ym > end_ym: return`) already flatten the top; the remaining depth comes from the per-month fetch loop body (not shown in this excerpt — read lines 450+ before implementing). Likely seam: extract "fetch and yield one month's games, handling the 404/410-skip case" into a helper generator, mirroring `fetch_lichess_games`'s per-line extraction below. |
| `import_service.py:1010 _make_game_iterator` | 5 | `tests/test_import_service.py`, `tests/services/test_import_service.py` [VERIFIED: grep] | The `elif job.platform == "lichess":` branch's nested `if job.since_ms_override is not None: ... else: if previous_last_synced_at is not None: if last_synced.tzinfo is None: ...` chain is the deep part. Extract into `_resolve_lichess_since_ms(job, previous_last_synced_at) -> int \| None`, called once before the `async for game in lichess_client.fetch_lichess_games(...)` line. The chess.com branch's nested `_on_archive_skipped` closure is already a separate scope (doesn't count toward depth) — no change needed there. |
| `library_service.py:478 _build_card` | 5 | `tests/services/test_library_service.py` [VERIFIED: grep] | The `if positions:` branch (lines ~566+) containing `for fr in rows_for_tactic:` with nested `tactic_slot_visible` calls and `if allowed_visible and ...:` is the deep part. Extract the per-row tactic-slot computation into `_build_tactic_by_ply_entry(fr, pos_by_ply, mover_is_white_at_ply) -> tuple[int, _TacticByPlyEntry] \| None`, called inside the loop. |
| `lichess_client.py:51 fetch_lichess_games` | 7 | `tests/test_lichess_client.py`, `tests/test_import_service.py` [VERIFIED: grep] | Two seams: (1) extract the status-code branch (`if response.status_code == 404: ... if response.status_code != 200: if ==429: ... if in _RETRYABLE_STATUS_CODES: ... raise RuntimeError`, lines ~164-191) into `_raise_for_status(response, username) -> None` (raises `ValueError`/`_RetryableStatusError`/`RuntimeError`, returns normally on 200). (2) extract the per-NDJSON-line parse+normalize (`json.loads` try/except + `normalize_lichess_game` try/except, lines ~197-220) into a synchronous helper `_normalize_line(line, username, user_id) -> NormalizedGame \| None` that swallows both exception types and returns `None` to signal skip; keep only `if not line.strip(): continue`, the helper call, the `None` check, and `yield`/`on_game_fetched()` in the async-generator body. Both seams independently reduce depth; likely only (2) is needed to clear the depth-4 bar, but both improve readability. |
| `openings_service.py:282 get_time_series` | 5 | `tests/test_openings_time_series.py`, `tests/test_aggregation_sanity.py` [VERIFIED: grep] | Extract the per-bookmark body (`for bkm in request.bookmarks:` loop contents, lines ~302-370ish, containing the nested `for played_at, result, user_color in rows:` / `if _in_window(...):` / `if outcome == "win": elif ...: else:` chain) into `_build_bookmark_time_series(rows, request) -> BookmarkTimeSeries`, called once per bookmark in the outer loop. |
| `user_benchmark_percentiles_service.py:428 compute_stage_a` | 6 | `tests/services/test_user_benchmark_percentiles_service.py`, `tests/services/test_import_service_stage_a.py`, `tests/services/test_percentile_compute_gate.py` [VERIFIED: grep] | Extract the per-`tc` cell body (`try: result = await _compute_metric_for_user_per_tc(...) ... except asyncio.CancelledError: raise ... except Exception as exc: ...`, lines ~458-493) into `_compute_and_upsert_cell(session, user_id, metric, tc, anchor, cohort_table, stage_label) -> None`, called inside the `for tc, anchor in anchors.items():` loop. This is the SAME seam that fixes `compute_stage_b` below — both functions share nearly identical structure, so a single shared helper (parameterized on `stage_label` for the Sentry context and on whether the outer loop is single- or double-nested) may be worth considering, though CLAUDE.md's "don't split just to fit a signature" caveat applies if the two call sites end up needing materially different parameter sets. |
| `user_benchmark_percentiles_service.py:505 compute_stage_b` | 7 | `tests/services/test_eval_drain_stage_b.py`, `tests/services/test_user_benchmark_percentiles_service.py`, `tests/services/test_user_benchmark_percentiles_service_real_data.py` [VERIFIED: grep] | Same seam as `compute_stage_a`, one level deeper because of the extra `for family in STAGE_B_METRIC_FAMILIES: for tc, anchor in anchors.items():` double loop. Extracting the inner try/except cell body into a helper (as above) removes 2 levels, dropping this from depth 7 to depth 5 (double loop = 2, helper call = +0) — **may still breach depth 4** unless the double loop itself is also addressed (e.g. iterate `itertools.product(STAGE_B_METRIC_FAMILIES, anchors.items())` to flatten to one loop, or extract the whole double-loop body as one call per outer iteration). Verify actual post-refactor depth with the gate script before considering this function done — do not assume the same one-helper fix that works for `compute_stage_a` is sufficient here. |

**All eight breach locations were reproduced by directly running the gate script this session** [VERIFIED, see above] — the planner does not need to re-run it to confirm CONTEXT.md D-13's list is current, but the executor SHOULD re-run it after each fix to confirm the depth actually dropped below 5 (the LOC-only literal-heavy exemption does not apply to depth; a partial extraction that still leaves depth 5 is not done).

### Digest pins (D-16, verified this session via `docker pull`)
```dockerfile
# frontend/Dockerfile
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS builder
...
FROM caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d AS runtime
```
[VERIFIED: `docker pull node:24-alpine` → `Digest: sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf`; `docker pull caddy:2.11.4` → `Digest: sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d` — both run this session via the local `docker` CLI, not scraped from a web page. Re-pull immediately before implementing if there's any gap in time, since `node:24-alpine` (a rolling tag) can move]. This mirrors `Dockerfile:1,22`'s existing `python:3.13-slim@sha256:d168b8d9eb761f4d3fe305ebd04aeb7e7f2de0297cec5fb2f8f6403244621664` pattern exactly [VERIFIED: Dockerfile:1,22] — both pins are the multi-arch manifest-list digest (same style as the existing pin), so Docker still resolves the correct platform at build/pull time.

### Rate limiter eviction fix (F-17, all three limiters share this one class)
```python
# app/core/ip_rate_limiter.py — _SlidingWindowRateLimiter.is_allowed(), current (lines 29-42):
def is_allowed(self, ip: str) -> bool:
    now = time.monotonic()
    cutoff = now - self._window_seconds
    timestamps = self._timestamps[ip]
    self._timestamps[ip] = [t for t in timestamps if t > cutoff]
    if len(self._timestamps[ip]) >= self._max_requests:
        return False
    self._timestamps[ip].append(now)
    return True
```
[VERIFIED: app/core/ip_rate_limiter.py:29-42]. Fix: after the eviction line, if the pruned list is empty AND the request is about to be rejected (or after any prune that leaves it empty and it's not about to receive a new timestamp), `del self._timestamps[ip]`. Exact placement needs care: the append-on-success path re-populates the key immediately, so the `del` only matters on the **reject** branch (when `len(...) >= max_requests` is False after pruning but the key was pruned to empty by a PRIOR request that never returns... actually re-derive from the loop: eviction happens on every call regardless of outcome, so add `if not self._timestamps[ip]: del self._timestamps[ip]` immediately after the prune line, before the `len()` check — an empty list can't be `>= max_requests` (0 >= 5 is False) so the accept path is unaffected, and the subsequent `.append(now)` would need to re-create the `defaultdict` entry, which `defaultdict[str, list]`'s `__getitem__`/`__setitem__` does transparently. Both `feedback_rate_limiter.py` and `reset_password_rate_limiter.py` import this same class [VERIFIED: both files' source, this session] — fixing the one shared class fixes all three call sites; no per-file changes needed beyond this one class body.

### Hex literal replacement (F-20) — existing theme.ts precedent
`theme.ts` already has the exact "near-black"/"near-white" pattern needed:
```typescript
// frontend/src/lib/theme.ts:585-586 (existing precedent, NOT identical value)
export const TRAIN_STREAK_BADGE_FG = 'oklch(0.20 0 0)'; // near-black
// frontend/src/lib/theme.ts:96 (existing precedent, NOT identical value)
export const SIDE_SWATCH_WHITE = 'oklch(0.985 0 0)';
```
[VERIFIED: theme.ts:585-586, 96]. **Important caveat:** this repo's existing `--charcoal` CSS variable is `#161412` [VERIFIED: frontend/src/index.css:63 `--charcoal: #161412;`], which is a **visually distinct** color from the `#1a1a1a` literal used in `Home.tsx`/`MaiaMoveQualityBar.tsx` — reusing `--charcoal`/`bg-charcoal` would be a small but real color change, not a pure hoist. The exact lines needing replacement:
```
frontend/src/pages/Home.tsx:410:  className="lg:hidden bg-[#1a1a1a] py-12"
frontend/src/pages/Home.tsx:436:  ? 'lg:bg-[#1a1a1a]'
frontend/src/pages/Home.tsx:437:  : 'max-lg:bg-[#1a1a1a]';
frontend/src/components/analysis/MaiaMoveQualityBar.tsx:566:  color: meta.darkText ? '#1a1a1a' : '#ffffff',
```
[VERIFIED: exact grep this session — matches CONTEXT.md's `Home.tsx:410,436,437` and `MaiaMoveQualityBar.tsx:566` citations exactly]. Recommend a NEW named token (e.g. `SURFACE_DARK = '#1a1a1a'` or an oklch-equivalent computed to match, kept distinct from `--charcoal`) rather than silently substituting `--charcoal` and changing the rendered color — this is a discretion call for the planner/executor, but the zero-visual-diff option is a new token, not reuse.

### Migration housekeeping (F-21, F-14)
`compare_type` is **not currently set** in either `context.configure()` call in `alembic/env.py` [VERIFIED: `grep -n "compare_type"` returned zero matches; both `context.configure()` calls read at lines 71 and 144 — neither has the parameter]. Add `compare_type=True` to the online-mode call (`do_run_migrations`, line 144 — this is the one exercised by `alembic upgrade head`/`alembic revision --autogenerate` in real usage) and, for consistency, the offline-mode call (line 71, rarely used but should match).

**Exactly 10 migrations have a no-op `downgrade()`** — independently reproduced this session via a script that extracts each file's `downgrade()` body and flags ones consisting only of `pass`:
```
alembic/versions/20260322_135825_b5b8170c0f72_fix_time_control_bucket_for_600s_games.py
alembic/versions/20260403_200000_repair_bookmark_hashes_and_sort_order.py
alembic/versions/20260403_203535_adfafb71bacc_repair_bookmark_fens_and_target_hashes.py
alembic/versions/20260524_170733_fd5b551f381c_extend_benchmark_metric_for_tc_pressure.py
alembic/versions/20260526_222651_1945ae56aa20_reshape_user_benchmark_percentiles.py
alembic/versions/20260527_125014_c70f5d94b243_reshape_user_rating_anchors_for_blended_.py
alembic/versions/20260530_extend_benchmark_metric_for_rate_percentiles.py
alembic/versions/20260614_120000_phase_117_1_eval_convention_cleanslate.py
alembic/versions/20260614_130000_wipe_eval_only_residue.py
alembic/versions/20260701_190758_eb341e836ee9_suppress_ungated_tactic_tags_old_corpus.py
```
[VERIFIED: reproduced this session — count matches the seed's "10" claim exactly]. Each needs a one-line docstring/comment noting the downgrade is deliberately irreversible (data-repair/cleanup migrations can't be meaningfully undone) — no code change to the `downgrade()` bodies themselves.

### `.env.example` gap (F-18) — confirmed via `app/core/config.py`, NOT via reading `.env.example` itself
```python
# app/core/config.py — all four fields confirmed present with these exact types/defaults:
OAUTH_TUNNEL_ORIGINS: str = ""                       # line 40
BEST_MOVE_BACKFILL_ENABLED: bool = False             # line 98
BENCHMARK_SELECTION_GATE_ENABLED: bool = False        # line 118
BENCHMARK_HOMOGENIZE_EVAL_SOURCE: bool = False        # line 140
```
[VERIFIED: app/core/config.py:40,98,118,140 — quoted verbatim]. `.env.example` itself could NOT be read this session (see Pitfall 3) — the planner cannot verify these four fields' ABSENCE from `.env.example` independently of the seed's claim, only their presence/type/default in the Settings class. Treat "these 4 are missing from `.env.example`" as `[CITED: SEED-161 §7 / F-18]`, not independently re-verified this session.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `pip install uv` in CI | `astral-sh/setup-uv` action with `enable-cache: true` | This phase | Saves the uv binary download AND caches the resolved wheel set across runs, not just the interpreter. |
| Report-only-forever CSP philosophy | Report-only NOW, enforcing LATER after Sentry violation data accumulates | CONTEXT.md D-07/deferred | Standard rollout pattern for a first-ever CSP on a mature app; avoids breaking real users on day one. |
| Nesting-depth left ungated | AST-based custom gate (`check_function_size.py`) added to CI + pre-merge, since no stable ruff rule covers it | Phase 214 built the tool; Phase 216 gates it | `ruff`'s `PLR1702` is preview-only and enabling `--preview` would explode the effective rule set project-wide [CITED: scripts/check_function_size.py's own docstring, which documents this investigation]. |

**Deprecated/outdated:** none identified as newly obsolete by this phase — it's closing gaps in already-current tooling, not migrating off something old.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Sentry `report-to`/`Reporting-Endpoints` headers are not worth adding alongside `report-uri` given report-only mode and browser support parity | Pattern 4 | Low — pure scope/complexity tradeoff, reversible any time; if wrong, just add the second header later. |
| A2 | The recommended CSP `img-src 'self' data: blob:' directive is correct — carried from CONTEXT.md's candidate, not independently re-verified against every `<img>`/background-image usage this session | Pattern 3 | Low (report-only) — a missing `img-src` origin would just generate a Sentry violation report, not break the site; tighten later from real violation data. |
| A3 | `uv lock --upgrade-package <name>` leaves all other packages' locked versions completely untouched (only re-resolving what the named package's own upgrade requires) | Pitfall 1 | Medium — if wrong, a "scoped" upgrade could still cascade into `anthropic`/`complexipy` transitively; verify with a `--dry-run` before committing the real lock file, and re-check the diff doesn't touch the two excluded packages. |
| A4 | `astral-sh/setup-uv`'s current major tag is `v10.x` | Standard Stack | Low — cosmetic; re-verify the actual current tag at implementation time (action majors move independently of this research). |
| A5 | The `.env.example` file is missing exactly `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`, `BENCHMARK_SELECTION_GATE_ENABLED`, `BEST_MOVE_BACKFILL_ENABLED`, `OAUTH_TUNNEL_ORIGINS` (per SEED-161 F-18) | Code Examples | Low-Medium — this session could not read `.env.example` to independently confirm the ABSENCE claim (only confirmed the four fields exist and their types/defaults in `config.py`); if the seed's claim is stale (file changed since 2026-09-04), the executor should `grep` for each field name in `.env.example` (if permission allows in that session) before adding duplicate lines. |

**If this table is empty:** N/A — see entries above.

## Open Questions (RESOLVED)

All three are carried by a plan task; none block execution.

1. **Can `.env.example` be read in the executing session?** — RESOLVED: `216-07` Task 5 carries a read precondition with an escalation path (halt and ask, never write blind).
   - What we know: Both `Read` and `Bash cat`/`grep` were denied by permission settings for this exact file this session, for reasons not stated beyond "denied by your permission settings" / "Permission ... has been denied".
   - What's unclear: Whether this is a session-specific or persistent restriction, and whether it applies equally to `Edit`/`Write` (which the phase needs to use to add the 4 lines).
   - Recommendation: The executor should attempt a normal `Read`/`Edit` at implementation time — if blocked identically, escalate to the user for an explicit one-time permission grant on this file, since the phase cannot complete group 7c without editing it.

2. **Exact Sentry DSN public key + ingest host.** — RESOLVED: `216-02` Task 1 is a blocking `checkpoint:human-action`; the user pastes the security-report URL from Sentry Client Keys.
   - What we know: Org slug `flawchess`, project ID `4511084868272208`, region `de.sentry.io` (from CLAUDE.md); the report-uri format (from Sentry docs).
   - What's unclear: The numeric org-ingest prefix and public key, which only exist inside the DSN itself (a runtime secret not present in any repo file).
   - Recommendation: `checkpoint:human-verify` task — human opens Sentry's Client Keys or Security Headers settings page and pastes the exact endpoint string into the Caddyfile.

3. **Whether `caddy validate` in CI needs a stub/dummy value for anything the Caddyfile references that only exists in the real prod environment.** — RESOLVED: the planner ran the docker `caddy validate` invocation against the current Caddyfile (exit 0, no live upstreams needed); `216-01`/`216-02` run it locally as an automated verify before the CI step lands.
   - What we know: `caddy validate` "loads and provisions all modules as if to start the config, but does not start it" [CITED: caddyserver.com/docs/command-line#caddy-validate] — this typically means it does NOT need live upstreams (Caddy's reverse_proxy provisioning doesn't require the backend to be reachable), but it WILL fail if referenced files (e.g. a TLS cert path, if any were hardcoded — none found in this Caddyfile) don't exist.
   - What's unclear: Whether the CI runner (no Docker network with `backend:8000`/`umami:3000` resolvable) causes `caddy validate` to fail on DNS-resolution provisioning for the `reverse_proxy` blocks' upstream hostnames.
   - Recommendation: The planner should have the executor actually run `docker run --rm -v $(pwd)/deploy/Caddyfile:/etc/caddy/Caddyfile caddy:2.11.4 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` locally before writing the CI step, to confirm it passes without a live Docker Compose network — if it fails on DNS resolution, the CI step will need `caddy validate` alone (fine, since validate doesn't dial the upstream, only that it doesn't error on hostname format — reverse_proxy upstream provisioning in Caddy does NOT require the DNS name to currently resolve; it defers resolution to request time).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker (local) | digest lookups, `caddy validate` local test | ✓ | — | — |
| `docker compose -f docker-compose.dev.yml` (dev DB) | backend tests, `/api/health` manual check | ✓ (already running: `flawchess-dev-db-1`, healthy) [VERIFIED this session] | postgres:18-alpine | — |
| `gh` CLI | CI run-time lookups, PR/release flow | ✓ (worked this session — `gh run list` succeeded; CONTEXT.md's "deferred" note about a 401 auth failure did NOT reproduce this session) | — | — |
| `uv` | dependency dry-runs | ✓ | — | — |
| `npm` | `npm outdated` | ✓ | — | — |

**Missing dependencies with no fallback:** none identified.
**Missing dependencies with fallback:** none identified.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Backend framework | pytest (`[tool.pytest.ini_options]` in `pyproject.toml:65`) [VERIFIED] |
| Backend config file | `pyproject.toml` |
| Frontend framework | vitest (`"test": "vitest run"` in `frontend/package.json:14`) [VERIFIED] |
| Quick run command | `uv run pytest tests/test_<relevant>.py -x` (backend); `cd frontend && npx vitest run <file>` (frontend) |
| Full suite command | `uv run pytest -n auto -x` (backend); `cd frontend && npm test -- --run` (frontend) |

### Phase Requirements → Test Map
No formal REQUIREMENTS.md IDs exist for this phase (per the task's `<phase_requirements>` note: "none"). Mapping instead to the seven success criteria:

| Success criterion | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| SC-1 (client IP) | Caddy trusts CF ranges, real IP in `last_ip` | manual/HUMAN-UAT (prod-only, post-deploy) | `SELECT last_ip, max(last_seen) FROM worker_heartbeats GROUP BY 1 ORDER BY 2 DESC LIMIT 5` on prod | N/A — no automated test possible pre-deploy |
| SC-2 (headers) | `curl -I` shows all 5 headers, no COOP/COEP | CI (new `caddy validate` step) + manual (deploy health-check curl assertion) | `caddy validate --config deploy/Caddyfile --adapter caddyfile`; `curl -I https://flawchess.com/ \| grep -qi strict-transport-security` etc. | ❌ Wave 0 — new CI step |
| SC-3 (Renovate) | App installed, dashboard open | HUMAN-UAT (GitHub UI action) | N/A | N/A |
| SC-4 (CI caching) | Median CI run time drops | manual observation (`gh run list` before/after) | `gh run list --workflow=ci.yml --json createdAt,updatedAt` | N/A |
| SC-5 (`/api/health`) | 503 on DB failure/timeout, 200 otherwise | unit/integration | `uv run pytest tests/test_health.py -x` (NEW FILE) | ❌ Wave 0 — no existing test |
| SC-6 (function-size gate) | Zero breaches, CI + pre-merge gated | integration (gate script itself) | `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` | ✅ script exists; the 8 fixes need their existing test suites re-run: `tests/test_bookmarks_router.py`, `tests/test_chesscom_client.py`, `tests/test_import_service.py`, `tests/services/test_import_service.py`, `tests/services/test_library_service.py`, `tests/test_lichess_client.py`, `tests/test_openings_time_series.py`, `tests/test_aggregation_sanity.py`, `tests/services/test_user_benchmark_percentiles_service.py`, `tests/services/test_user_benchmark_percentiles_service_real_data.py`, `tests/services/test_import_service_stage_a.py`, `tests/services/test_eval_drain_stage_b.py`, `tests/services/test_percentile_compute_gate.py`, `tests/routers/test_imports_readiness.py` (all VERIFIED present this session) |
| SC-7 (housekeeping) | Per-bullet, mostly config/docs | mixed — see per-bullet notes below | — | — |

### Sampling Rate
- **Per task commit:** relevant test file(s) from the table above, e.g. `uv run pytest tests/services/test_user_benchmark_percentiles_service.py -x` after the `compute_stage_a`/`compute_stage_b` refactor.
- **Per wave merge:** full pre-merge gate per CLAUDE.md (`ruff format`, `ruff check --fix`, `ty check` both projects, `pytest -n auto -x`, frontend `lint` + `test`) — CONTEXT.md's `<decisions>` explicitly calls out D-04 and D-13 as "the only plans that touch application code and each needs the full pre-merge gate."
- **Phase gate:** full suite green before `/gsd-verify-work`, plus the new `check_function_size.py` gate green.

### Wave 0 Gaps
- [ ] `tests/test_health.py` (NEW) — covers SC-5: happy path (DB reachable → 200 `{"status": "ok"}`), failure path (DB raises → 503), timeout path (DB hangs past `_HEALTH_DB_TIMEOUT_S` → 503). Failure/timeout paths need a per-test `dependency_overrides[get_async_session]` that raises/sleeps, restored to the session-scoped `_test_session_generator` afterward (see Pattern 5 above for why `.pop()` alone is wrong here).
- [ ] No other new test infrastructure needed — every other group either has existing coverage (D-13's 8 functions) or is config/docs-only (groups 1-4, 6-7) where the verification is `caddy validate`/`curl -I`/manual/HUMAN-UAT rather than pytest.

## Security Domain

`security_enforcement` is absent from `.planning/config.json` → treated as enabled per the researcher contract; this phase is unusually security-dense (headers, CSP, client-IP trust) so this section is directly load-bearing, not boilerplate.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No (unchanged this phase) | FastAPI-Users JWT, unchanged — F-04 (JWT lifetime) explicitly out of scope |
| V3 Session Management | No (unchanged) | — |
| V4 Access Control | Partial — guest-creation rate limiter's correctness depends on group 1's fix | Per-real-IP `_SlidingWindowRateLimiter` (already exists; group 1 fixes its INPUT, not its logic) |
| V5 Input Validation | No new user input surfaces this phase | — |
| V6 Cryptography | No | — |
| V9 (Communications) | Yes — HSTS | `Strict-Transport-Security` header (D-06) — standard, never hand-rolled |
| V14 (Config) | Yes — this phase's core | Security headers via Caddy `header` directive (standard reverse-proxy pattern, not hand-rolled middleware); CSP via Caddy, report-only initially |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| IP-spoofing via forged `X-Forwarded-For`/`Cf-Connecting-Ip` from a non-Cloudflare source reaching the origin directly | Spoofing | `trusted_proxies static <CF ranges>` means Caddy ONLY trusts `client_ip_headers`-named headers from connections whose IMMEDIATE peer is in the trusted range — a direct connection to the origin's public IP (bypassing Cloudflare) would not be in `trusted_proxies` and Caddy would use the raw socket peer instead, not an attacker-supplied header. This is exactly what `trusted_proxies` is for — verify the origin's firewall/hosting doesn't expose a non-Cloudflare-routed path to port 443 (out of scope for this phase but worth a note: Hetzner Cloud Firewall rules are documented as "inbound TCP 22/80/443 + ICMP from any" [VERIFIED: docs/production-runbook.md:43] — i.e. the origin IS directly reachable on 443 from any IP, not restricted to Cloudflare's ranges; an attacker who discovers the origin's real IP could bypass Cloudflare AND `trusted_proxies` entirely by connecting directly and forging `Cf-Connecting-Ip` themselves, since THEIR connection's peer IS attacker-controlled but Caddy only checks that the PEER address (not the header content) is in the trusted range — a direct attacker connection has peer == attacker's own IP, which is NOT in the Cloudflare ranges, so Caddy would correctly ignore their forged header and use their real peer IP instead. This is safe by construction, contingent on the firewall not being tightened to CF-only in a way that assumes header trust — no action needed this phase, flagging for awareness only). |
| Reflected/stored XSS exploiting the 7-day localStorage JWT (F-04, explicitly deferred) | Tampering/Info disclosure | CSP (this phase, report-only) is a partial, delayed mitigation — F-04's proper fix (shorter JWT lifetime + refresh/denylist) is explicitly out of scope; CONTEXT.md's `<deferred>` section already notes CSP enforcement should follow after a few weeks of report-only data. |
| Clickjacking | Tampering | `frame-ancestors 'none'` in the CSP (report-only initially, still valuable as a report signal) |
| MIME-sniffing-based content-type confusion | Tampering | `X-Content-Type-Options: nosniff` (D-06) |
| Cross-origin data leakage via `Referer` header | Info disclosure | `Referrer-Policy: strict-origin-when-cross-origin` (D-06) |
| Unauthorized use of camera/mic/geolocation via a compromised or malicious embedded script | Elevation of privilege | `Permissions-Policy` denying all three (D-06) |

## Sources

### Primary (HIGH confidence)
- `deploy/Caddyfile`, `deploy/entrypoint.sh`, `.github/workflows/ci.yml`, `app/main.py`, `app/core/config.py`, `app/core/ip_rate_limiter.py`, `app/core/feedback_rate_limiter.py`, `app/core/reset_password_rate_limiter.py`, `Dockerfile`, `frontend/Dockerfile`, `frontend/index.html`, `frontend/src/instrument.ts`, `frontend/src/api/googleAuth.ts`, `frontend/src/components/auth/LoginForm.tsx`, `frontend/src/lib/engine/*.ts`, `frontend/src/lib/theme.ts`, `frontend/src/index.css`, `scripts/check_function_size.py`, `alembic/env.py`, `alembic/versions/*.py`, `app/routers/position_bookmarks.py`, `app/services/{chesscom_client,import_service,library_service,lichess_client,openings_service,user_benchmark_percentiles_service}.py`, `renovate.json`, `README.md`, `docs/dev-tooling.md`, `docs/production-runbook.md`, `.planning/phases/216-audit-bugs-and-quick-wins/216-CONTEXT.md`, `.planning/seeds/SEED-161-audit-2026-09-04-bugs-and-quick-wins.md`, `reports/quality-assessment/flawchess_quality_assessment_2026-09-04.md` — all read directly this session.
- Command output captured this session: `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200`; `uv lock --upgrade --dry-run`; `npm outdated` (frontend); `docker pull node:24-alpine`; `docker pull caddy:2.11.4`; `git worktree list`; `du -sh .claude/worktrees/agent-a740fb7ec554451f9`; `gh run list --workflow=ci.yml`.

### Secondary (MEDIUM confidence)
- caddyserver.com/docs/caddyfile/options (trusted_proxies/client_ip_headers syntax) — WebFetch this session.
- caddyserver.com/docs/caddyfile/directives (directive ordering) — WebFetch this session.
- caddyserver.com/docs/caddyfile/directives/header (header syntax, defer behavior) — WebFetch this session.
- caddyserver.com/docs/command-line#caddy-validate — WebFetch this session.
- docs.sentry.io/platforms/python/security-policy-reporting/ (report-uri format) — WebFetch + WebSearch this session.
- docs.astral.sh/uv/reference/cli/#uv-lock (`--upgrade` vs `--upgrade-package` semantics) — WebFetch this session.
- github.com/astral-sh/setup-uv, github.com/actions/setup-node — WebFetch this session (action input names; re-verify current tag at implementation time).
- cloudflare.com/ips-v4, cloudflare.com/ips-v6 — WebFetch this session (CIDR ranges; re-fetch at implementation time per D-11's own script, don't hand-copy).

### Tertiary (LOW confidence)
- None relied upon for load-bearing claims; every WebFetch/WebSearch result above was cross-checked against at least the CONTEXT.md's own candidate values or this repo's existing conventions.

## Metadata

**Confidence breakdown:**
- Caddy config / CSP / security headers: HIGH for what's grounded in this repo's source (asset inventory, OAuth flow, worker construction), MEDIUM for external Caddy/Sentry syntax (official docs, but fetched via a summarizing tool rather than raw page content).
- Function-size gate fixes: HIGH — breach list reproduced directly, test coverage confirmed via grep, seams derived from actually reading each function's source.
- Dependency catch-up: HIGH — the D-04/D-05 conflict is a directly-reproduced `--dry-run` finding, not a inference.
- Housekeeping: HIGH except the `.env.example` absence claim (MEDIUM — inherited from the seed, not independently re-verified due to a tool permission block).

**Research date:** 2026-09-04
**Valid until:** ~7 days for the Cloudflare IP ranges and Docker digests (both can drift; re-verify at implementation time regardless of this date), ~30 days for everything else.

## RESEARCH COMPLETE
