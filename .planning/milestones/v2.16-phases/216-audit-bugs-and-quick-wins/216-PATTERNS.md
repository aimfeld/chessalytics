# Phase 216: Audit Bugs and Quick Wins - Pattern Map

**Mapped:** 2026-09-04
**Files analyzed:** 26 (create/modify), grouped into 7 seed groups
**Analogs found:** 24 / 26 (2 net-new files with no direct in-repo analog: `bin/check_cloudflare_ips.sh`, `tests/test_health.py` — both use adjacent conventions, not a single copy source)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `deploy/Caddyfile` (global `servers{}` trust block) | config | request-response | same file, existing global `{ log { ... } }` block | exact (self) |
| `deploy/Caddyfile` (site `header{}` block) | config | request-response | same file, existing `handle @static { header ... }` Cache-Control lines | role-match |
| `bin/check_cloudflare_ips.sh` | utility | batch (fetch + diff) | `bin/install_stockfish.sh` | role-match |
| `.github/workflows/ci.yml` (setup-uv cache) | config | batch | same file, existing `Install uv` step | exact (self) |
| `.github/workflows/ci.yml` (setup-node cache) | config | batch | same file, existing `actions/setup-node@v6` step | exact (self) |
| `.github/workflows/ci.yml` (`caddy validate` step) | config | batch | same file, `Zone drift check` step pattern (run + assert) | role-match |
| `.github/workflows/ci.yml` (function-size gate step) | config | batch | same file, `Lint (ruff)` step (run `uv run ...`, fail on non-zero exit) | exact-pattern |
| `.github/workflows/ci.yml` (deploy header assertion) | config | batch | same file, existing `Health check` step's curl loop | exact (self) |
| `app/main.py::health_check` | route handler | request-response | `app/routers/position_bookmarks.py` (session dependency usage) | role-match |
| `tests/test_health.py` (NEW) | test | request-response | `tests/test_last_activity_middleware.py` (dependency_overrides pattern, `tests/conftest.py`) | role-match |
| `app/routers/position_bookmarks.py::get_suggestions` | controller | CRUD (read) | itself (extract-helper refactor) | exact (self) |
| `app/services/chesscom_client.py::fetch_chesscom_games_backward` | service | streaming | itself + `app/services/lichess_client.py::fetch_lichess_games` (sibling fetch generator) | role-match |
| `app/services/import_service.py::_make_game_iterator` | service | streaming | itself | exact (self) |
| `app/services/library_service.py::_build_card` | service | transform | itself | exact (self) |
| `app/services/lichess_client.py::fetch_lichess_games` | service | streaming | itself | exact (self) |
| `app/services/openings_service.py::get_time_series` | service | transform | itself | exact (self) |
| `app/services/user_benchmark_percentiles_service.py::compute_stage_a` | service | batch | itself (shares seam with `compute_stage_b`) | exact (self) |
| `app/services/user_benchmark_percentiles_service.py::compute_stage_b` | service | batch | `compute_stage_a` in the same file (near-identical structure) | exact |
| `app/core/ip_rate_limiter.py::_SlidingWindowRateLimiter.is_allowed` | utility | CRUD (in-memory) | itself | exact (self) |
| `app/core/feedback_rate_limiter.py` | utility | CRUD (in-memory) | `app/core/ip_rate_limiter.py` (imports `_SlidingWindowRateLimiter`, no own logic) | exact |
| `app/core/reset_password_rate_limiter.py` | utility | CRUD (in-memory) | `app/core/ip_rate_limiter.py` | exact |
| `frontend/Dockerfile` | config | file-I/O (build) | root `Dockerfile` (digest-pin convention) | exact-pattern |
| `.env.example` | config | — | `app/core/config.py::Settings` (source of truth for the 4 fields) | role-match (cross-file) |
| `frontend/src/pages/Home.tsx` (hex literals) | component | transform | `frontend/src/lib/theme.ts` (existing near-black/near-white tokens) | role-match |
| `frontend/src/components/analysis/MaiaMoveQualityBar.tsx` (hex literals) | component | transform | `frontend/src/lib/theme.ts` | role-match |
| `alembic/env.py` (`compare_type=True`) | config | batch | same file, both `context.configure()` calls | exact (self) |
| `alembic/versions/*.py` (10 no-op downgrades) | migration | batch | same files, existing `def downgrade()` bodies | exact (self) |
| `CLAUDE.md` (pre-merge gate line) | config/docs | — | same file, existing pre-merge gate code block | exact (self) |
| `docs/dev-tooling.md`, `docs/production-runbook.md` | docs | — | same files, existing script-inventory entries | exact (self) |

## Pattern Assignments

### `deploy/Caddyfile` — global trust block + site header block (config, request-response)

**Analog:** same file's existing global block and `handle @static` header lines.

**Existing global block style** (`deploy/Caddyfile:1-19`):
```caddyfile
{
    # Global log filter. This exists because a site-level `log` block's format
    # applies ONLY to `http.log.access.logN` — Caddy's ERROR logger
    # (`http.log.error.logN`), which is exactly what fires on a proxy 502, is
    # routed to the default logger and bypasses it entirely. ...
    log {
        format filter {
            wrap json
            fields {
                request>headers delete
                request>uri query {
                    replace token REDACTED
                }
            }
        }
    }
}
```
Every non-obvious directive in this file carries a "why" comment naming the incident/rationale (see the `# SECRET REDACTION.` block at `deploy/Caddyfile:45-62`). The new `trusted_proxies`/`client_ip_headers` and `header{}` blocks MUST follow this same documented-rationale style — cite the source URLs for the CF ranges directly above the `trusted_proxies static` line, and note which finding (client-IP/SEED-161 group 1, headers/group 2) motivated each new directive.

**Existing header-setting style inside `handle @static`** (`deploy/Caddyfile:99-105`):
```caddyfile
@nocache path /sw.js /registerSW.js /manifest.webmanifest /push-sw.js
header @nocache Cache-Control "no-cache"

@immutable path /assets/*
header @immutable Cache-Control "public, max-age=31536000, immutable"
```
The new security-`header{}` block goes UNCONDITIONED in the site body (not inside `handle @static`), per RESEARCH.md Pattern 2 — Caddy's directive ordering runs `header` before any `handle` regardless of source position, so placement anywhere in the top-level `flawchess.com { }` body (before the `log {}` block, matching the file's existing top-to-bottom sectioning of `encode` → access-log comment → `log{}` → `handle` blocks) is correct and covers `/api/*` and the SPA fallback too, not just static assets.

**Comment convention to preserve:** every directive block starts with a comment paragraph explaining WHY, referencing the finding ID / incident, matching this file's own `# SECRET REDACTION.` and `# Content-hashed assets ...` blocks (lines 45, 102).

---

### `bin/check_cloudflare_ips.sh` (NEW) — utility, batch fetch+diff

**Analog:** `bin/install_stockfish.sh`

**Header comment + shebang + strict mode** (`bin/install_stockfish.sh:1-19`):
```bash
#!/usr/bin/env bash
# Idempotent Stockfish installer for local dev.
#
# ... multi-line rationale comment ...

set -euo pipefail
```

**Download helper pattern (curl/wget fallback)** (`bin/install_stockfish.sh:59-67`):
```bash
if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -q "$1" -O "$2"; }
else
  echo "Error: need 'curl' or 'wget' in PATH." >&2
  exit 1
fi
```

**Exit-code convention:** the script exits 0 with a status message when nothing needs doing (`bin/install_stockfish.sh:59-61`, "already installed, exit 0") and exits non-zero with a clear stderr message on a real problem (`bin/install_stockfish.sh:42-49`, unsupported platform). `check_cloudflare_ips.sh` should mirror this: fetch `https://www.cloudflare.com/ips-v4` and `/ips-v6`, diff against the inline block in `deploy/Caddyfile`, print a clear "ranges match" / "drift detected: <diff>" message, exit 0 / non-zero accordingly. Use `mktemp -d` + `trap 'rm -rf "$tmp"' EXIT` for scratch files (`bin/install_stockfish.sh:91-92`).

**Not an analog for:** interactive/idempotent-install semantics (version-stamp file) — this script is a stateless diff-and-report, closer in spirit to a lint/gate script; borrow only the download-fallback and exit-code conventions, not the install/stamp logic.

---

### `.github/workflows/ci.yml` — caching, `caddy validate`, function-size gate, header assertion (config, batch)

**Analog:** same file throughout.

**Current uv install step to replace with `astral-sh/setup-uv`** (`ci.yml:33-35`):
```yaml
- name: Install uv
  run: pip install uv
```
Replace with `astral-sh/setup-uv@v10` (or current major tag — re-verify at implementation time), `with: enable-cache: true`, keeping the subsequent `uv sync --locked --group maia-inference` step (`ci.yml` "Install Python dependencies") unchanged.

**Existing `actions/setup-node@v6` step** (`ci.yml:125`) — add `with: cache: 'npm'` and `cache-dependency-path: frontend/package-lock.json`, no other structural change.

**Lint-step pattern for the function-size gate** (`ci.yml:82-89`, run-and-fail-on-nonzero-exit convention — no extra `if`/assertion needed, the tool's own exit code gates the job):
```yaml
- name: Lint (ruff)
  run: uv run ruff check .

- name: Format check (ruff)
  run: uv run ruff format --check app/ tests/ scripts/ analysis/
```
New step, placed after ty check (`ci.yml:89`) per D-14:
```yaml
- name: Function-size gate
  run: uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200
```

**Drift-check pattern for `caddy validate`** (`ci.yml`, "Zone drift check" — run then assert):
```yaml
- name: Zone drift check
  run: |
    uv run python scripts/gen_endgame_zones_ts.py
    git diff --exit-code frontend/src/generated/endgameZones.ts
```
`caddy validate` is self-asserting (non-zero exit on invalid config), so the new step is simpler — a single `run:` invoking the pinned `caddy:2.11.4` image or a locally-installed `caddy` binary against `deploy/Caddyfile`, no `git diff` needed. Per RESEARCH.md Open Question 3, verify locally first with `docker run --rm -v $(pwd)/deploy/Caddyfile:/etc/caddy/Caddyfile caddy:2.11.4 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` before writing the CI step.

**Health-check curl loop to extend** (`ci.yml:239-249`, "Health check" step):
```yaml
- name: Health check
  run: |
    for i in $(seq 1 36); do
      if curl -sf https://flawchess.com/api/health; then
        echo "Health check passed"
        exit 0
      fi
      sleep 5
    done
    echo "Health check failed after 180s"
    exit 1
```
D-09(b) extends this: after the loop passes, add a `curl -I https://flawchess.com/` header assertion (grep for HSTS/nosniff/Referrer-Policy/Permissions-Policy/CSP-Report-Only, fail on any missing) using the same shell-`run:` style already established here and in the vite-preview COOP/COEP guard (`ci.yml:160-170`, `PAGE_HEADERS=$(curl -sf -I http://localhost:4173/ 2>&1)` pattern) — reuse that exact `curl -sf -I ... | grep -qi <header-name>` idiom for each of the five headers.

---

### `app/main.py::health_check` (route handler, request-response)

**Analog:** `app/routers/position_bookmarks.py` (session-dependency pattern used across all routers); current implementation is the file being modified.

**Current state** (`app/main.py:307-309`):
```python
@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}
```

**Session dependency injection pattern used project-wide** (standard FastAPI-Users/SQLAlchemy async pattern; e.g. `position_bookmarks.py:40`-style signature):
```python
from typing import Annotated
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import get_async_session

async def some_handler(
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> ...:
    ...
```

**Target shape** (per RESEARCH.md Pattern 5, already drafted and verified against this repo's conventions):
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
        sentry_sdk.capture_exception(exc)  # CLAUDE.md Sentry rule — non-trivial except block
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"status": "degraded"})
    return {"status": "ok"}
```
`sentry_sdk` is already imported at the top of `app/main.py` (`import sentry_sdk`, line 9) — no new import needed there.

---

### `tests/test_health.py` (NEW) — test, request-response

**Analog:** `tests/conftest.py` (`override_get_async_session` fixture) + `tests/test_last_activity_middleware.py` (calls `/api/health` incidentally).

**Session-override fixture** (`tests/conftest.py:374-416`, paraphrased structure — read the full fixture before writing the test, this excerpt shows the shape only):
```python
def override_get_async_session(test_engine):
    ...
    from app.core.database import get_async_session
    ...
    fastapi_app.dependency_overrides[get_async_session] = _test_session_generator
    yield
    fastapi_app.dependency_overrides.pop(get_async_session, None)
```
This is a **session-scoped autouse** fixture — the happy path (`SELECT 1` succeeds) is exercised for free by any test hitting `/api/health` through the normal `client` fixture. For the failure/timeout paths, `tests/test_health.py` needs a **per-test** override that raises or hangs, applied inside the test and explicitly restored to the real `_test_session_generator` afterward (not just `.pop()`, since the autouse fixture already put a working generator there — popping would leave later tests with no override at all). Structure per-test as:
```python
async def test_health_check_db_failure(client, monkeypatch):
    async def _failing_session():
        raise RuntimeError("boom")
        yield  # pragma: no cover
    app.dependency_overrides[get_async_session] = _failing_session
    try:
        response = await client.get("/api/health")
        assert response.status_code == 503
    finally:
        app.dependency_overrides[get_async_session] = original_override  # restore, not pop
```
Confirm the exact fixture name/shape by reading `tests/conftest.py:355-419` in full before implementing — this excerpt is illustrative, not verbatim.

---

### Eight function-size depth-breach fixes (services/routers, various data flows)

**Analog:** each function is its own analog — this is a pure zero-behavior-change extract-helper refactor, not a copy-from-elsewhere pattern. The one cross-function analog: `compute_stage_a` and `compute_stage_b` in `app/services/user_benchmark_percentiles_service.py` share near-identical structure, so the same helper-extraction seam applies to both (see CONTEXT.md D-13 and RESEARCH.md's per-function seam table for exact line ranges and helper names — already fully specified there, not repeated here to avoid drift from the single source of truth).

**Shared refactor convention** (CLAUDE.md "Coding Guidelines"): extract the innermost loop body into a `_helper_name(...)` function at module scope, called once per iteration from the original loop, which itself stays at the outer nesting level. Existing tests (enumerated per-function in RESEARCH.md's "Per-function refactor seam" table) are the oracle — do not rewrite them, only add new ones if a helper needs isolated coverage.

---

### Rate limiter eviction fix (`app/core/ip_rate_limiter.py`, `feedback_rate_limiter.py`, `reset_password_rate_limiter.py`)

**Analog:** `app/core/ip_rate_limiter.py::_SlidingWindowRateLimiter.is_allowed` is the single shared implementation; the other two files only import it.

**Current implementation** (`app/core/ip_rate_limiter.py:29-42`):
```python
def is_allowed(self, ip: str) -> bool:
    """Return True if the request from `ip` is within the rate limit, else False."""
    now = time.monotonic()
    cutoff = now - self._window_seconds

    # Evict timestamps outside the sliding window
    timestamps = self._timestamps[ip]
    self._timestamps[ip] = [t for t in timestamps if t > cutoff]

    if len(self._timestamps[ip]) >= self._max_requests:
        return False

    self._timestamps[ip].append(now)
    return True
```
**Fix** (per CONTEXT.md discretion + RESEARCH.md's derivation): add `if not self._timestamps[ip]: del self._timestamps[ip]` immediately after the prune line, before the `len()` check. An empty list can never satisfy `>= max_requests` so the accept path is unaffected; `defaultdict.__setitem__` transparently re-creates the key on the subsequent `.append(now)`. This is the ONLY class body that needs editing — `feedback_rate_limiter.py` and `reset_password_rate_limiter.py` both `from app.core.ip_rate_limiter import _SlidingWindowRateLimiter` with no own logic to touch.

---

### `frontend/Dockerfile` — digest pins (config, file-I/O)

**Analog:** root `Dockerfile:1,22` (existing digest-pin convention).

**Existing pattern** (`Dockerfile:1-2,22`):
```dockerfile
FROM python:3.13-slim@sha256:d168b8d9eb761f4d3fe305ebd04aeb7e7f2de0297cec5fb2f8f6403244621664 AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.9@sha256:10902f58a1606787602f303954cea099626a4adb02acbac4c69920fe9d278f82 /uv /uvx /bin/
...
FROM python:3.13-slim@sha256:d168b8d9eb761f4d3fe305ebd04aeb7e7f2de0297cec5fb2f8f6403244621664 AS runtime
```
Apply the identical `image:tag@sha256:<digest>` form to `frontend/Dockerfile`'s `node:24-alpine` and `caddy:2.11.4` base images — RESEARCH.md's Code Examples section already has the exact digests captured this session (`node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf`, `caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d`) — re-pull immediately before implementing since `node:24-alpine` is a rolling tag that can move.

---

### `frontend/src/pages/Home.tsx` / `MaiaMoveQualityBar.tsx` hex literals → theme token (component, transform)

**Analog:** `frontend/src/lib/theme.ts` existing near-black/near-white token exports.

**Existing token style** (`frontend/src/lib/theme.ts:585-586, 96`):
```typescript
export const TRAIN_STREAK_BADGE_FG = 'oklch(0.20 0 0)'; // near-black
export const SIDE_SWATCH_WHITE = 'oklch(0.985 0 0)';
```
Add a NEW named token (not a reuse of the existing `--charcoal: #161412` CSS var, which is a visually distinct color from `#1a1a1a`) — e.g. `SURFACE_DARK = '#1a1a1a'` — exported from `theme.ts` following this exact `export const NAME = 'value'; // comment` style, then import and use it at the four call sites:
```
frontend/src/pages/Home.tsx:410   className="lg:hidden bg-[#1a1a1a] py-12"
frontend/src/pages/Home.tsx:436   ? 'lg:bg-[#1a1a1a]'
frontend/src/pages/Home.tsx:437   : 'max-lg:bg-[#1a1a1a]';
frontend/src/components/analysis/MaiaMoveQualityBar.tsx:566  color: meta.darkText ? '#1a1a1a' : '#ffffff',
```

---

### `alembic/env.py` — `compare_type=True`

**Analog:** same file, both existing `context.configure()` calls.

**Offline call** (`alembic/env.py:70-76`):
```python
context.configure(
    url=url,
    target_metadata=target_metadata,
    literal_binds=True,
    dialect_opts={"paramstyle": "named"},
)
```
**Online call** (`alembic/env.py:143-147`):
```python
context.configure(
    connection=connection,
    target_metadata=target_metadata,
    include_object=_include_object,
)
```
Add `compare_type=True,` as a new kwarg to both calls (online call is the one exercised by `alembic upgrade head`/`--autogenerate`; add to offline too for consistency per RESEARCH.md).

---

### `alembic/versions/*.py` — no-op `downgrade()` docstrings (10 files)

**Analog:** each file's own existing `def downgrade()` body (currently bare `pass`, per RESEARCH.md's confirmed list of exactly 10 files). Add a one-line comment/docstring above or inside each `downgrade()` noting the irreversibility reason (data-repair/cleanup migration can't be meaningfully undone) — no functional code change. Exact file list (verified count matches "10" in RESEARCH.md Code Examples):
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

---

### `.env.example` — 4 missing Settings fields

**Analog:** `app/core/config.py::Settings` (source of truth for field name/type/default — `.env.example` itself could not be independently read this session per RESEARCH.md Pitfall 3; the executor should read the real file directly before editing to match its existing comment/grouping convention).
```python
# app/core/config.py — confirmed present, exact lines:
OAUTH_TUNNEL_ORIGINS: str = ""                       # line 40
BEST_MOVE_BACKFILL_ENABLED: bool = False             # line 98
BENCHMARK_SELECTION_GATE_ENABLED: bool = False        # line 118
BENCHMARK_HOMOGENIZE_EVAL_SOURCE: bool = False        # line 140
```
Add four commented (`# `) lines to `.env.example` in the style already established by its neighboring entries (grep for one adjacent existing field's comment style before writing these four).

---

## Shared Patterns

### Sentry capture on non-trivial exceptions
**Source:** CLAUDE.md "Error Handling & Sentry" (repo-wide convention, not a single file)
**Apply to:** `app/main.py::health_check`'s except block (DB failure/timeout is non-trivial — always capture).
```python
except (AsyncTimeoutError, Exception) as exc:
    sentry_sdk.capture_exception(exc)
```

### Named constants, never magic numbers
**Source:** CLAUDE.md "Coding Guidelines"
**Apply to:** `_HEALTH_DB_TIMEOUT_S = 2.0` in `app/main.py`; any other new literal introduced by this phase (e.g. rate-limiter eviction has no new literal).

### Documented "why" comments on every non-obvious Caddy directive
**Source:** `deploy/Caddyfile` (existing convention throughout the file)
**Apply to:** the new `trusted_proxies`/`client_ip_headers` block and the new `header{}` security block — both need a comment paragraph citing the finding/source, matching the file's existing style exactly.

### GitHub Actions: tag-pinned (not SHA-pinned) action versions
**Source:** `.github/workflows/ci.yml` (`actions/checkout@v7`, `actions/setup-python@v6`, `actions/setup-node@v6`)
**Apply to:** the new `astral-sh/setup-uv@vN` step — pin by major tag, re-verify the current tag at implementation time.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `bin/check_cloudflare_ips.sh` | utility | batch (fetch+diff) | No existing `bin/*.sh` script does a "fetch remote list, diff against a committed config block, exit non-zero on drift" — closest is `install_stockfish.sh`'s download/hash-check machinery, borrowed for helpers only, not the core diff logic. |
| `tests/test_health.py` | test | request-response | No existing test exercises `/api/health` behaviorally (only incidental path-string references) — the per-test dependency-override-with-restore pattern must be assembled from `tests/conftest.py`'s fixture rather than copied from a sibling test file. |

## Metadata

**Analog search scope:** `deploy/`, `.github/workflows/`, `app/main.py`, `app/routers/`, `app/services/`, `app/core/`, `bin/`, `tests/conftest.py`, `Dockerfile`, `frontend/Dockerfile`, `frontend/src/lib/theme.ts`, `frontend/src/pages/Home.tsx`, `frontend/src/components/analysis/MaiaMoveQualityBar.tsx`, `alembic/env.py`, `alembic/versions/`, `.env.example` (blocked, used `app/core/config.py` instead), `CLAUDE.md`, `docs/dev-tooling.md`, `docs/production-runbook.md`.
**Files scanned:** ~20 read directly this session (plus RESEARCH.md's own exhaustive prior-session reads, reused here rather than re-read).
**Pattern extraction date:** 2026-09-04
