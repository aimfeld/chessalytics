# External Integrations

**Analysis Date:** 2026-09-02

## APIs & External Services

**Chess Data Import:**
- chess.com public API — `app/services/chesscom_client.py` (`BASE_URL = "https://api.chess.com/pub/player"`); requires a `User-Agent` header on every request; fetches monthly game archives sequentially with 100-300ms rate-limit delays; normalized to a unified schema via `app/services/chesscom_to_lichess.py`
- lichess API — `app/services/lichess_client.py`; streams NDJSON line-by-line (`Accept: application/x-ndjson`); also requires a mandatory `User-Agent` (lichess started rejecting generic client UAs ~2026-07-22); `since`/`until` params use **millisecond** timestamps, not seconds; only `Standard` variant games are imported (Chess960/crazyhouse etc. filtered out)
- Both clients used exclusively via `httpx.AsyncClient` (never `requests`)

**LLM (narrated insights):**
- Anthropic — via `pydantic-ai-slim[anthropic]`, model strings like `"anthropic:claude-haiku-4-5-20251001"`
- Google Gemini — via `pydantic-ai-slim[google]`, model strings like `"google:gemini-3.5-flash"`; Gemini-specific thinking controls (`GEMINI_THINKING_LEVEL`, `GEMINI_THINKING_BUDGET`, `GEMINI_INCLUDE_THOUGHTS`) applied only when the model string starts with `google:`/`google-cloud:`
- Orchestration: `app/services/insights_llm.py`, `app/core/config.py` (`PYDANTIC_AI_MODEL_INSIGHTS`)
- Auth: provider API keys read directly from process env by pydantic-ai's providers (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`) — `load_dotenv()` is called explicitly in `app/core/config.py` so these reach `os.environ`, not just the Settings object
- Cost tracking: `genai-prices` package for usage/cost attribution, logged to `llm_logs` table
- Startup gate: empty `PYDANTIC_AI_MODEL_INSIGHTS` aborts app startup via `get_insights_agent()` raising `UserError` in the lifespan (D-22/D-23)

**Transactional Email:**
- Resend — `RESEND_API_KEY` / `MAIL_FROM` settings; empty key = unconfigured, all sends become no-ops (`email_service.is_email_configured()`)

## Data Storage

**Databases:**
- PostgreSQL only (no SQLite anywhere), accessed via SQLAlchemy 2.x async + `asyncpg`
- Four named targets resolved through `app/core/config.py`'s `db_url_for_target()`:
  - `DATABASE_URL_DEV` — local Docker Postgres 18, port 5432
  - `DATABASE_URL_TEST` — test DB, cloned per pytest session from a migrated template (`tests/conftest.py`), auto-refreshes on Alembic head change
  - `DATABASE_URL_PROD` — production, reached via SSH tunnel (`bin/prod_db_tunnel.sh`)
  - `DATABASE_URL_BENCHMARK` — separate benchmark Postgres, port 5433, its own compose file (`docker-compose.benchmark.yml`)
- ORM: SQLAlchemy 2.x async, `select()` API (`app/models/`, `app/repositories/`)
- Migrations: Alembic (`alembic/versions/`, `alembic.ini`, `alembic/env.py`)
- Three query-only PostgreSQL MCP servers configured for AI-assisted querying: `flawchess-db` (dev), `flawchess-prod-db` (needs `bin/prod_db_tunnel.sh`), `flawchess-benchmark-db` (needs `bin/benchmark_db.sh start`)

**File Storage:**
- Local filesystem only — no S3/GCS/blob storage detected. `logo/`, `screenshots/`, `misc/` are static repo assets; no upload/media pipeline found.

**Caching:**
- No dedicated cache service (no Redis/Memcached detected). `pg_stat_statements` extension is enabled on Postgres for query-performance introspection, not caching.

## Authentication & Identity

**Auth Provider:**
- FastAPI-Users (`fastapi-users[oauth,sqlalchemy] >=15.0.4`) — email/password + Google OAuth
- Google OAuth — `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` settings, `httpx-oauth` as the OAuth transport, `app/routers/auth.py`
- Session: JWT-based, signed with `SECRET_KEY`; app refuses to boot in non-development environments with the default insecure key (`assert_secret_key_configured()` in `app/core/config.py`, called from the app lifespan)
- Guest accounts — `app/services/guest_service.py`, `app/services/guest_cleanup_service.py` (periodic inactivity cleanup task in `app/main.py` lifespan)
- Models: `app/models/user.py`, `app/models/oauth_account.py`
- Cookie security: `Secure` flag on auth cookies is dropped only when `ENVIRONMENT=development` (to work over plain HTTP locally)

## Monitoring & Observability

**Error Tracking:**
- Sentry (backend) — `sentry-sdk[fastapi]`, initialized conditionally on non-empty `SENTRY_DSN` in `app/main.py`; `send_default_pii=False`; custom `traces_sampler` (not a flat rate) to exclude high-volume remote-worker poll endpoints from trace quota; custom `before_send` hook. Dashboard: https://flawchess.sentry.io (org/project `flawchess`, ID `4511084868272208`, region `de.sentry.io`)
- Sentry (frontend) — `@sentry/react`, initialized in `frontend/src/instrument.ts`
- Convention: every non-trivial `except` in `app/services/`/`app/routers/` must call `sentry_sdk.capture_exception()`; retry loops capture only on the final attempt; variable data goes into `set_context()`/`set_tag()`, never interpolated into the error message string (preserves Sentry grouping)

**Logs:**
- Standard Python `logging` in the backend; Docker JSON-file logging with rotation limits set explicitly on the Caddy service in `docker-compose.yml` (Docker's default has no rotation)
- Caddy access logs redact ALL request headers (not a blacklist) — two known secrets that leaked before this fix: `X-Operator-Token` (remote-worker shared secret) and password-reset `?token=` query params; redaction lives in `deploy/Caddyfile`'s global `log { format filter { ... } }` block, duplicated for both the access logger (`http.log.access.logN`) and the error logger (`http.log.error.logN`, which a site-level `log` block's format does NOT cover)
- Prod docker logs retain roughly 1 hour and only surface `WARNING`+ from `app/` — Sentry is the source of truth for anything older or at INFO level

## CI/CD & Deployment

**Hosting:**
- Self-hosted via Docker Compose behind Caddy (not a managed PaaS): `flawchess.com` (main app), `flawchess.org`/`www.flawchess.org` (redirect to `.com`), `analytics.flawchess.com` (reverse-proxies to a self-hosted Umami instance for analytics)
- Umami — self-hosted web analytics (`umami:3000` upstream in `deploy/Caddyfile`); frontend integration referenced in `frontend/CLAUDE.md`

**CI Pipeline:**
- GitHub Actions (`.github/` present) — runs ruff, ty, pytest (serial), frontend lint/test/build, `audit-ci` vulnerability gate
- `gh` CLI used for monitoring runs (`gh run watch <id> --exit-status`; `gh pr checks --watch` is known to exit 0 even on failures — do not rely on it)

**Deployment:**
- `bin/deploy.sh` — the only sanctioned deploy path (never direct SSH)
- GitLab Flow: `main` (integration trunk, local squash-merge per phase) → PR → `production` branch (exact prod state) → `bin/deploy.sh`
- `deploy/cloud-init.yml` — server provisioning; `deploy/entrypoint.sh` — container entrypoint

## Environment Configuration

**Required env vars (non-exhaustive, see `app/core/config.py` for full defaults):**
- `DATABASE_URL`, `DATABASE_URL_DEV`, `DATABASE_URL_TEST`, `DATABASE_URL_PROD`, `DATABASE_URL_BENCHMARK`
- `SECRET_KEY` (deploy-blocker if default outside dev)
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `BACKEND_URL`, `FRONTEND_URL`, `OAUTH_TUNNEL_ORIGINS`, `ENVIRONMENT`
- `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`
- `PYDANTIC_AI_MODEL_INSIGHTS`, `GEMINI_THINKING_LEVEL`, `GEMINI_THINKING_BUDGET`, `GEMINI_INCLUDE_THOUGHTS`, `INSIGHTS_HIDE_OVERVIEW`
- `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` (read directly by pydantic-ai providers, not declared as `Settings` fields)
- `EVAL_AUTO_DRAIN_ENABLED`, `BEST_MOVE_BACKFILL_ENABLED`, `BENCHMARK_SELECTION_GATE_ENABLED`, `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` (feature-flag booleans; the two benchmark ones must NEVER be true in prod)
- `EVAL_OPERATOR_TOKEN`, `EVAL_FALLBACK_OPERATOR_TOKEN`, `EVAL_BENCHMARK_OPERATOR_TOKEN` (remote eval-worker auth)
- `EXPECTED_SF_VERSION` (Stockfish version gate)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (Web Push; empty = feature disabled)
- `RESEND_API_KEY`, `MAIL_FROM` (email; empty = feature disabled)

**Secrets location:**
- Local dev: `.env` (gitignored)
- Production: `/opt/flawchess/.env` on the server only, never committed; `.prod.env` in the repo is a reference/template, not the live secret file
- 1Password integration for secret sync: `bin/download_1password.sh`, `bin/upload_1password.sh`

## Webhooks & Callbacks

**Incoming:**
- Google OAuth redirect callback (FastAPI-Users OAuth flow), built from `FRONTEND_URL`/`OAUTH_TUNNEL_ORIGINS`
- Remote eval-worker poll/lease/submit endpoints (`app/routers/eval_remote.py`) — not webhooks in the push sense, but an authenticated (`X-Operator-Token`) pull-based worker protocol for distributing Stockfish/best-move analysis to a fleet of remote workers

**Outgoing:**
- Web Push notifications — `app/services/push_send.py`, `app/services/push_crypto.py` (vendored VAPID-signed Web Push, not a third-party push package), triggered by `app/services/train_reminder_service.py`'s periodic reminder ticker
- Resend transactional email sends (`app/services/email_service.py`, inferred from `is_email_configured()` reference)
- No inbound webhook receivers from chess.com/lichess/Stripe/etc. detected — both chess platforms are polled, not subscribed to

---

*Integration audit: 2026-09-02*
