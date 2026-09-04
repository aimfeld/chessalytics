# Quality Assessment — `flawchess` — chess analysis platform that ranks moves by practical human score, not engine truth

| Field  | Value |
|--------|-------|
| Date   | 2026-09-04 |
| Scope  | `/home/aimfeld/Projects/Python/flawchess` — ≈193,200 code LOC Python (592 files: `app/` 49,750, `tests/` 108,500, `scripts/` 25,300, `alembic/` 6,500, `analysis/` 3,100), ≈110,700 code LOC TypeScript/TSX (`frontend/src` non-test 59,600, tests 54,200), ≈5,600 SQL; 470 test files / ≈162,700 LOC of tests; 5,965 tracked files |
| Author | Claude (Fable 5.1) via the `codebase-audit:report` skill (v0.5.0) |
| Method | Static analysis of the repository at commit `9b099f57c` on branch `main`, plus both test suites executed. Backend: 4,499 passed / 4,518 (19 skipped), 92% coverage. Frontend: 3,894 passed / 3,894, 80.8% statement coverage — see §1. Prior report: `flawchess_quality_assessment_2026-08-09.md` (commit `a13815dd9`, 344 commits ago); deltas against it are called out where relevant. This run also had a standing brief to flag bugs and quick wins; those are marked **[bug]** / **[quick win]** in §4 and collected in §6/§8. |

**Context.** FlawChess is a free, open-source (AGPL-3.0) chess analysis platform at flawchess.com. Users import their game history from chess.com and lichess; positions are matched by 64-bit Zobrist hash rather than opening name, then win/draw/loss rates, blunder and tactic tagging, endgame conversion, time-management leaks, and spaced-repetition drills are computed from the user's own games. The differentiator is an in-browser engine fusing Stockfish evaluation with Maia human-move prediction to rank moves by expected *practical* score at the user's rating, which also drives 24 named bot personas. Stack: FastAPI + Python 3.13 + SQLAlchemy 2 async + PostgreSQL 18, React 19 / TypeScript 6 / Vite 8 PWA, Docker Compose on a single Hetzner CPX42 behind Caddy, now fronted by Cloudflare's CDN (cut over 2026-08-11). GitLab-Flow `main` → `production`. Single maintainer, six months old, 3,411 commits.

---

## Method & Limitations

**What this is.** A senior-engineer static review of a git repo at a specific commit, produced by Claude via the `codebase-audit:report` skill in minutes. Every non-trivial claim cites `file:line` so a reviewer can verify each finding in under a minute.

**What this is not.** Not a formal audit. No interviews with the development team. No legal or professional accountability. No ISO 25010 weighted-scoring methodology. No dynamic penetration testing or load testing. Use this as a first-pass engineering review, not as a substitute for an investor-grade or compliance-grade assessment.

**Confidence levels.** Each finding in the §5 Findings Register is tagged with one of three confidence levels (applies to individual *claims*):

- **Verified** — claim backed by end-to-end reading of the cited file(s).
- **Likely** — claim backed by spot-check of representative files, or strongly implied by configuration.
- **Inferred** — claim backed by absence of contrary evidence (e.g., "no `.github/workflows/` found → no CI"). Inferred ≠ wrong, but is the most likely to miss something the repo's maintainers know that the static analysis cannot see.

**Section assessability.** Each row in §1 Summary Stats carries one of three assessability tiers (applies to *whole sections* — a step above claim-level confidence):

- **Measured** — we ran the tool or parsed the artifact (e.g., coverage artifact exists and was read; tests were executed).
- **Inferred from artifacts** — we read configs and lockfiles but didn't execute anything.
- **Not assessable without setup** — the probe requires tooling or deps that aren't installed in this environment.

A finding sourced from a "Not assessable" section must not exceed **Inferred** in §5.

**Environment tier.** `warm` — LOC tool on PATH and at least one test runner has its deps installed. No §1 row reads `Not assessable without setup`. Two extra data sources were reachable this run and are cited where used: the Sentry MCP (unresolved production issues, last 14 days) and a read-only tunnel to the production database (one `worker_heartbeats` aggregate, used solely to confirm the Cloudflare client-IP finding; tunnel closed afterwards).

**Dynamic validation.** Backend suite: 4,499 passed / 19 skipped / 0 failed, 92% line coverage, 102.5 s wall clock under `-n auto`. Frontend suite: 3,894 passed / 3,894, 80.79% statements / 82.88% lines / 74.33% branches / 72.67% functions, 74.1 s. Working tree was byte-identical before and after both runs (`git status --porcelain` empty). Additionally `ruff check .`, `ruff format --check`, `eslint .`, `knip`, and `tsc -b` all exited 0. Results are separate from the Maintainability grade, which reflects test-suite design, not runtime pass/fail.

**Grade rubric.** A = best-practice everywhere. B = solid with small known gaps. C = works but has real rough edges. D = risky, don't ship. F = broken or absent. `+` / `−` denote half-steps; a dimension drops one tier for each missing obvious element (no backups, no deps automation, etc.). See the §2 Executive Summary table for the per-dimension grades.

---

## 1. Summary Stats

| Metric | Value | Notes |
|---|---|---|
| Total code LOC | 320,820 | Measured (tokei, excl. Markdown/JSON, excl. `.claude/worktrees`): Python 193,180 / TSX 67,288 / TypeScript 43,367 / JavaScript 9,843 / SQL 5,608 / Shell 824 / CSS 462. Application source proper: `app/` 49,754 and `frontend/src` non-test 59,589; the rest is tests, `scripts/`, `alembic/`, research harnesses. |
| Comment LOC | 63,266 (16.5% of code+comment) | Measured. Python 19,918 (9.3%); TS+TSX 38,212 (25.7%). Comments are load-bearing and record *why* — e.g. `pyproject.toml:37-42` (why onnxruntime is pinned exactly), `app/main.py:96-121` (why logging had to be configured by hand). |
| Test LOC | 162,743 (51% of code LOC) | Measured. Backend `tests/` 108,500 across 219 files; frontend `__tests__/` 54,243 across 251 files. Integration-heavy against a real PostgreSQL, not mock-heavy. |
| Test suite run — backend | `4,499 passed / 4,518, 0 failed, 19 skipped, coverage 92%` | Measured. `uv run pytest -n auto -q --cov=app --cov-report=term` (README lines 240-256 + CLAUDE.md `-n auto` guidance). 102.5 s. Up from 4,275 tests / 91% on 2026-08-09. |
| Test suite run — frontend | `3,894 passed / 3,894, 0 failed, coverage 80.79% stmts` | Measured. `cd frontend && npx vitest run --coverage --coverage.reporter=text-summary` (`frontend/package.json` `test` script). 74.1 s. Lines 82.88%, branches 74.33%, functions 72.67%. Up from 3,439 / 77.5%. The August timeout flake is gone: `frontend/vite.config.ts:48-49` now sets a 20 s test / 30 s hook ceiling project-wide. |
| Test coverage | Backend 92%, frontend 80.8% | Measured. Per-suite rows are authoritative; no cross-language aggregate exists. |
| Commits (last 90 days) | 1,718 | Measured. ≈19/day sustained, single maintainer. Total 3,411 since 2026-03-11. 203 of the 1,718 (12%) carry a `fix` prefix. |
| Active contributors (last 90 days) | 1 human (+ dependabot bot) | Measured. Bus factor 1. |
| Primary languages | Python, TypeScript, SQL, Shell | Measured. |
| Total files tracked | 5,965 | Measured (`git ls-files`). |
| Dependency manifests | `pyproject.toml`, `frontend/package.json`, `scripts/package.json`, `analysis/pyproject.toml`, `Dockerfile`, `Dockerfile.worker`, `frontend/Dockerfile`, `docker-compose*.yml` (4 files) | Measured. |
| Lockfiles present | Yes | Measured. `uv.lock` (388 KB) and `frontend/package-lock.json` committed; enforced in CI via `uv sync --locked` (`ci.yml:45`) and `npm ci` (`ci.yml:130`). |

---

## 2. Executive Summary

| Dimension | Grade | One-line finding |
|---|---|---|
| Architecture | **B+** | Router/service/repository layering is documented and followed; `Analysis.tsx` shrank from 4,049 to 2,761 LOC since August (Phase 215), but `app/routers/eval_remote.py` (1,563 LOC, 10 inline `session.execute`) and 8 functions past the project's own "hard 4" nesting limit remain, and that limit is not CI-gated. |
| Code duplication | **A−** | One `apply_game_filters()` with 30 call sites; four generated-TS drift gates in CI (`ci.yml:48-65`); 3 `relationship()` declarations across 32 models. |
| Error handling / Observability | **A−** | 97 `capture_exception()` against 163 `except` in `app/`, zero bare excepts, zero empty JS catches, `before_send` fingerprinting, global `QueryCache`/`MutationCache` handlers, and **zero unresolved production Sentry issues in the last 14 days**. |
| Secrets / config | **A** | `.env`/`.prod.env` gitignored (`.gitignore:156-158`), no credential-shaped files, boot-time `assert_secret_key_configured()` (`app/main.py:126`); only nit is 4 `Settings` fields absent from `.env.example`. |
| Code smells | **A** | 2 real TODO stubs in the whole tree (`scripts/gen_benchmarks.py:179,190`), 0 `@ts-ignore`, 0 real `any`, 25 `exhaustive-deps` disables mostly with written rationale. |
| Maintainability / tests | **A−** | 8,393 tests, 92%/81% coverage, per-run cloned PostgreSQL templates, 11 CI gates; docked because the function-size gate (`scripts/check_function_size.py`) currently reports 8 hard-limit breaches and runs nowhere in CI, and complexipy (89 functions >15) is report-only. |
| Security | **C+** | Auth crypto and CI scanning are strong (argon2, timing-safe OAuth CSRF, pip-audit + audit-ci + Trivy + CodeQL), but production still ships **no security response headers**, keeps a 7-day JWT in `localStorage`, and since the Cloudflare cutover the IP rate limiter is keyed on Cloudflare edge addresses **[bug]**. |
| Database design | **A−** | 29 FKs, every one with explicit `ondelete`; 29 unique and 26 check constraints; natural composite PKs on hot tables. 5 native PostgreSQL enums and 10 `ALTER TYPE … ADD VALUE` migrations contradict the project's own "avoid native ENUM" rule; 10 of 122 migrations have no-op downgrades. |
| Frontend quality | **A−** | `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`, 0 `any`, 933 `data-testid`, 219 `aria-label`, 0 `<div onClick>`, knip + eslint + tsc all green; 4 hex literals outside `theme.ts` and 107 `text-xs` against a stated `text-sm` floor. |
| Observability | **B+** | `app.*` loggers now actually emit INFO (`app/main.py:96-121`, fixed since August), Caddy access logs are JSON with secret redaction and rotation, Sentry is well-tuned on both ends; still plain-text format, no request-correlation ID, no off-box log retention, and `/api/health` does not touch the DB. |
| Performance | **B+** | Zero blocking I/O in async paths, the `asyncio.gather`-on-one-session hazard is documented at 10+ sites and respected, COPY-based position inserts chunked at 1,700 rows with the OOM rationale written down (`app/services/import_service.py:74-87`); no load-test artifacts. |
| Disaster recovery / backups | **C** | Hetzner daily whole-server snapshots, 7-day retention, offsite, RPO 24 h (`README.md:281-291`); no logical `pg_dump` layer, no PITR, no restore runbook, no tested restore. Unchanged since August. |
| Data privacy / GDPR | **C** | Honest prerendered privacy page, cookie-free Umami, CASCADE schema and a working guest purge (`app/services/guest_cleanup_service.py`), but registered-user erasure is still email-request-only and there is no data export. Unchanged since August. |
| Dependency management | **B+** | Lockfiles enforced, pip-audit `--strict`, audit-ci allowlist, Trivy, Python base images digest-pinned — but **Renovate has never opened a single PR since `renovate.json` landed on 2026-04-20** (configured but dead) **[bug]**; only Dependabot *security* PRs flow, and 27 npm packages sit behind their `wanted` range. |
| Frontend bundle / perf | **B** | 408 KB gzipped entry chunk (1.41 MB raw) is the unavoidable first-visit payload; 5 lazy routes; 44 MB WASM/ONNX correctly kept in `public/` with a 30-day cache policy. |
| CI/CD execution speed | **B** | 8 m 49 s median over the last 5 green `main` runs (range 8:10–9:27) for a very broad single-job gate — still **zero dependency caching** (`ci.yml:35,125`) and `docker compose build --no-cache` on every deploy (`ci.yml:236`). |
| Technical debt / legacy stack | **A** | Python 3.13, Node 24, React 19, PostgreSQL 18, Vite 8, TS 6, Tailwind 4, Caddy 2.11.4; no class components, no moment/jquery/lodash, no deprecated asyncio/FastAPI APIs; the two pinned-back deps carry written reasons. |

**Bottom line:** This is a production-grade codebase and it has kept improving: both suites are larger and greener than in August, the frontend timeout flake and the silent-logger bug are fixed, and the largest god-file was cut by a third. The standout strengths remain the test architecture (4,499 backend tests over a real PostgreSQL in 103 s) and the discipline of writing down *why* (pins, chunk sizes, log redaction). Two findings are new and both are quiet regressions rather than design gaps: the Cloudflare cutover on 2026-08-11 silently replaced every client IP the backend sees with a Cloudflare edge address, which breaks the guest-creation rate limiter and worker-fleet attribution; and Renovate, which the README badge and the previous report both credit, has never actually run. The three weakest dimensions are unchanged and still cheap: no security response headers, email-only GDPR erasure, and a 24-hour-RPO backup with no tested restore. Remaining work is closing specific gaps, not rescue.

---

## 3. What the App Actually Does — Operational Picture

1. **Auth and session** via `app/routers/auth.py` and `app/users.py:152-292`: FastAPI-Users with a `BearerTransport` JWT (7-day lifetime, `app/users.py:156,285`), email/password (argon2 via pwdlib) plus Google OAuth. Anonymous guest accounts get a 30-day token (`app/routers/auth.py:305-320`) and can be promoted in place to a Google identity. Impersonation tokens for admin support carry an `is_impersonation` claim that the activity middleware honours (`app/middleware/last_activity.py:68`).
2. **Import** via `app/services/import_service.py` (1,709 LOC): background async tasks fetch chess.com monthly archives sequentially with rate-limit delays and stream lichess NDJSON line-by-line. Both normalize into one schema (`app/schemas/normalization.py`, `app/services/normalization.py`) before storage, filtering to Standard-variant games. Games are written in batches of 30 with the Postgres-OOM reason for that number recorded at `import_service.py:74-87`.
3. **Position indexing** via `app/services/zobrist.py`: for every half-move, three 64-bit Zobrist hashes (white pieces only, black pieces only, full) go into `game_positions` via COPY in 1,700-row chunks (`app/repositories/game_repository.py:25,549`). Every position query is then an indexed integer equality; "my pieces only" system-opening queries are a single-column filter.
4. **Engine analysis** via `app/services/engine.py` + `app/routers/eval_remote.py`: a Stockfish UCI pool starts in the FastAPI lifespan and is supplemented by volunteer remote workers leasing work over an operator-token-gated API. Results are applied by `app/services/eval_apply.py` (2,995 LOC) and classified into blunders/mistakes plus 20+ tactic motifs by `app/services/tactic_detector.py` (2,637 LOC, precision-gated in CI at `ci.yml:122`).
5. **In-browser practical engine** via `frontend/src/lib/engine/`: Stockfish WASM and a Maia-3 ONNX policy net run in Web Workers, fused by expectimax inside an MCTS budget allocator. The same engine drives 24 bot personas (`frontend/src/lib/personas/`).
6. **Analytics surfaces** via `app/services/endgame_service.py` (3,817 LOC), `opening_insights_service.py`, `stats_service.py`, with per-user percentiles computed against a separate benchmark population database. LLM narration goes through pydantic-ai (`app/services/insights_llm.py`, 2,737 LOC) with every call logged to `llm_logs` for cost attribution.
7. **Spaced-repetition training** via `app/services/train_scheduler.py` + `app/repositories/train_repository.py` (3,183 LOC), on a due-date ladder with weekday masks; time-dependent endpoints take `now` from the `dev_now_utc` dependency (`app/core/dev_clock.py`).
8. **Delivery** via Cloudflare → `deploy/Caddyfile`: Caddy serves the prerendered SPA from `/srv` with per-asset-class cache policy and reverse-proxies `/api/*` to the backend container; uvicorn runs with `--proxy-headers --forwarded-allow-ips='*'` (`deploy/entrypoint.sh:10`). Alembic migrations run on backend container start. A separate static site, `stories/`, deploys to GitHub Pages on push (`.github/workflows/pages.yml`).

### Deployment & infrastructure

- Stack: Python 3.13 / FastAPI 0.115 / SQLAlchemy 2 async / asyncpg / PostgreSQL 18; React 19 / TypeScript 6 / Vite 8 / Tailwind 4; Caddy 2.11.4 with auto-TLS; Cloudflare proxy in front (`server: cloudflare`, `cf-ray` on every response; runbook `docs/cloudflare-cdn-cutover-runbook.md`).
- Host: single Hetzner CPX42 (8 vCPU, 16 GB, 160 GB NVMe) on Docker Compose. Postgres tuned in `docker-compose.yml:4-62`, `mem_limit`/`memswap_limit` on db (12 g), backend (4 g), umami (384 m); caddy logs rotated at 50 MB (`docker-compose.yml:157-160`).
- Deploy flow: GitLab Flow. Release = PR `main` → `production`, then `bin/deploy.sh` triggers `workflow_dispatch`, which re-runs the full gate and SSHes in for `git reset --hard origin/production` + `docker compose build --no-cache backend caddy` (`ci.yml:216-237`); aborts on a dirty server tree, health-checks `/api/health` for 180 s.
- CI workflow: `.github/workflows/ci.yml` — one job: 4 generated-file drift gates, pip-audit, ruff check + format, ty (root and `analysis/`), pinned Stockfish install, pytest (serial), tagger precision gate, `npm ci`, audit-ci, eslint, `tsc -b && vite build`, vitest, COOP/COEP + WASM MIME guard, knip, docker build, Trivy. Plus `codeql.yml`.

### Disaster Recovery & Backups

- **Database backups:** Hetzner automatic daily whole-server backups (`README.md:283`). No logical `pg_dump` layer; no backup script among the 15 in `bin/`.
- **Offsite storage:** Yes — Hetzner-managed snapshots stored off the VM.
- **Point-in-time recovery:** Off, stated at `README.md:290`.
- **Restore procedure documented:** No. `README.md:283` says "via the Hetzner Cloud Console"; `docs/production-runbook.md` contains no restore or snapshot section, although runbooks exist for VAPID rotation, email delivery, the benchmark lane, and the Cloudflare cutover.
- **Last tested restore:** Not tested — no evidence in repo, CI, docs, or commit history.
- **RPO / RTO targets:** RPO "up to 24 hours" (`README.md:289`). RTO not defined.

Unchanged from the August report, including the README's honest note that a logical dump "would be a useful second layer but is not currently configured" (`README.md:291`). Note also that the developer machine currently holds 6.4 GB of production and benchmark `pg_dump` archives under the gitignored `temp/` directory — those are the closest thing to a logical backup that exists, and they are ad hoc.

**Key insight.** The central architectural bet is Zobrist-hash position matching (`app/services/zobrist.py`, `app/models/game_position.py`): three precomputed 64-bit integers per half-move replace FEN comparison and opening taxonomies. It still holds up, and the schema keeps paying its cost deliberately: natural composite PK `(user_id, game_id, ply)`, `SmallInteger` ply, and partial indexes gated on `ply <= MAX_EXPLORER_PLY` (`app/models/game_position.py:74-120`). The second bet, which has matured since August, is the practical-score engine: the fusion is pure client-side compute, so the server never scales with engine load, and the 24 personas are data (`frontend/src/generated/personaCalibration.ts`, drift-gated in CI) rather than code.

---

## 4. Code Quality Findings

### 4.1 Architecture and layering

- Convention is stated in `CLAUDE.md` (routers = HTTP only, services = logic, repositories = DB) and the tree matches: 16 routers, 52 services, 22 repositories, 32 models, 19 schemas. Router prefix discipline is uniform across all 73 route decorators.
- **Progress since August.** `frontend/src/pages/Analysis.tsx` went from 4,049 to 2,761 LOC (Phase 215 decomposition, commit `67f9f0865`); route seeding moved to `frontend/src/hooks/analysis/useAnalysisRouteSeeding.ts`. `app/routers/eval_remote.py` grew to 1,563 LOC but its inline SQL dropped from ~25 to 10 `session.execute` sites.
- **Still open.** `eval_remote.py` is the one router that keeps SQL inline (10 sites; the other three routers touching SQL do 2–3 statements each: `auth.py`, `imports.py`, `position_bookmarks.py`) with no documented exception to the rule. On the service side `endgame_service.py` (3,817), `train_repository.py` (3,183), `eval_apply.py` (2,995) are the largest files; they are mostly pure `_aggregate_*`/`_compute_*` helpers, which is the right shape, but 3,800 lines is past the point where a new reader can hold the file.
- **The project's own hard limit is breached and ungated.** `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` reports 8 functions over the CLAUDE.md "hard 4" nesting limit: `app/routers/position_bookmarks.py:39` (5), `app/services/chesscom_client.py:375` (5), `import_service.py:1010` (5), `library_service.py:478` (5), `lichess_client.py:51` (**7**), `openings_service.py:282` (5), `user_benchmark_percentiles_service.py:428` (6) and `:505` (**7**). That script runs in neither `ci.yml` nor the documented pre-merge gate, so the rule is aspirational. `complexipy app/ --max-complexity-allowed 15` lists 89 functions over the ≤15 target (14 of them tactic detectors in `tactic_detector.py`), by design report-only. **[quick win]** add the size script to the pre-merge gate with the 8 current breaches baselined.
- Cross-cutting concerns are shared, not re-derived: one `LastActivityMiddleware`, one rate-limiter family in `app/core/`, one dev-clock dependency, one `apply_game_filters()`.

### 4.2 Code duplication

- `app/repositories/query_utils.py` `apply_game_filters()` has **30 call sites** across the repositories and services; time-control, platform, rated, opponent-type, recency, and color filtering exist once.
- Four CI drift gates regenerate TypeScript from Python and fail on any diff (`ci.yml:48-65`): endgame zones, flaw thresholds, bot strength curves, persona calibration. Threshold constants cannot diverge between the Python that computes them and the TS that renders them.
- 3 `relationship()` declarations across 32 models: explicit joins in repositories rather than N ways of spelling the same eager load.
- `app/services/push_crypto.py` vendors ~110 MIT lines from webpush-py instead of taking the dependency, with the reason at `pyproject.toml:50-58` and a differential test pinning behaviour.
- `_POSITION_CHUNK_SIZE` is exported from `game_repository.py:22-25` precisely so a second caller imports it instead of re-typing `1700` — the comment says so.

### 4.3 Error handling and observability

- Canonical probes: Python bare `except:` — **0 files / 0 sites**. JS/TS empty `catch {}` — **0 files**. 63 catches whose body is a single comment line (`rg -U`), i.e. deliberately swallowed with a written reason — spot-checked three, all engine/worker teardown paths.
- 97 `capture_exception` sites against 163 `except` blocks in `app/` (59%); 167 capture sites repo-wide including the frontend. The 12 `app/` files with `except` but no capture are all expected-condition handlers: timezone fallbacks (`train_scheduler.py:146,170,217`), JWT peek (`users.py:210,260`), `IntegrityError` races that are the documented idempotency mechanism (`guest_service.py:196`, `train_repository.py:2035`), typed insight failures mapped to 502 (`routers/insights.py:149-156`).
- `_sentry_before_send` collapses transient asyncpg connection errors to one fingerprint by walking `__cause__` (`app/main.py:73-88`); `_sentry_traces_sampler` drops the remote-worker poll endpoints from tracing (`:59-70`). `send_default_pii=False` (`:263`).
- Frontend: `QueryCache.onError` and `MutationCache.onError` report to Sentry (`frontend/src/lib/queryClient.ts:49-58`), `Sentry.ErrorBoundary` wraps the app (`App.tsx:1008`), and there are **0** `console.error`/`console.warn` calls in non-test source.
- Sentry MCP query `is:unresolved environment:production`, 14-day window: **0 issues**. Commit `7fc994cf7` ("capture swallowed engine and stored-PGN failures") shows the swallow-audit is an active practice.
- Retry discipline: chess.com/lichess clients capture on the final attempt only, per CLAUDE.md; no counter-example found.

### 4.4 Secrets and configuration

- Stats-script credential sweep: `CREDENTIAL_FILES_HIGH_CONFIDENCE_COUNT: 0`, `REVIEW_COUNT: 0`. No quarantine needed.
- `.env`, `.prod.env`, `prod.env`, `.envrc` are gitignored (`.gitignore:156-159`); `git ls-files` returns only `.env.example`. `git grep` for `sk-`, `xoxb-`, `ghp_`, `AKIA`, PEM headers across tracked source: no hits. `postgres://` literals with passwords exist only as the dev/test placeholders in `.env.example:21-31`, `app/core/config.py:25-28`, and `ci.yml:119`.
- `assert_secret_key_configured()` refuses to boot a non-development environment on the placeholder key (`app/core/config.py:197-213`, called first in the lifespan at `app/main.py:126`).
- Caddy access logs delete **all** request headers and redact `?token=` (`deploy/Caddyfile:8-16, 63-74`), with a global log block because the error logger bypasses the site filter — a lesson learned and written down.
- **[quick win]** Four `Settings` fields have no line in `.env.example`: `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`, `BENCHMARK_SELECTION_GATE_ENABLED`, `BEST_MOVE_BACKFILL_ENABLED`, `OAUTH_TUNNEL_ORIGINS`. The example file is the contract; add them commented out.

### 4.5 Code smells

- Canonical TODO/FIXME/XXX/HACK/DEPRECATED probe (excluding `reports/`, `.planning/`, `CHANGELOG.md`, `CLAUDE.md`, `temp/`, vendored engine files): **11 sites / 6 files**, of which 6 are inside the untracked `scripts/node_modules/`, 2 are `"p = X.XXX"` format-string docs, and 2 are the deliberate `_stub_chapter` "not yet ported" mechanism in `scripts/gen_benchmarks.py:179,190`. Effective count in application code: **0**.
- Magic numbers: the project's own rule is followed at every spot-check — `_GUEST_CREATE_MAX_REQUESTS = 5` (`app/core/ip_rate_limiter.py:8`), `_BATCH_SIZE = 30` with a paragraph of rationale (`import_service.py:74-87`), `TEST_TIMEOUT_MS = 20_000` (`frontend/vite.config.ts:48`).
- Suppressions: 68 `# ty: ignore[...]` in `app/` (all with rule name), `noqa` breakdown F401×14, E712×7, S608×6 (all six are f-string table/column composition with bound params, e.g. `eval_apply.py:442-530`), BLE001×5 (all "capture before re-raise"). Frontend: 32 `eslint-disable`, 25 of them `react-hooks/exhaustive-deps`; the ones in `TrainLineStepper.tsx:169,196` and `TrainSolveScreen.tsx:459` carry multi-sentence justifications, the ones in `AnalysisTagsPanel.tsx` (7 sites) and `useAnalysisRouteSeeding.ts` (5 sites) mostly do not.
- Dead code: knip runs in CI and passed locally; `noUnusedLocals`/`noUnusedParameters` on.
- **[quick win]** `.claude/worktrees/agent-a740fb7ec554451f9` is a 97 MB orphan directory: gitignored, but no longer registered (`git worktree list` shows only the main checkout and `../flawchess-123.1`). It also inflates the stats script's test-LOC heuristic. `rm -rf` it.

### 4.6 Maintainability and tests

- 219 backend test files (108,500 LOC) + 251 frontend test files (54,243 LOC); pytest + pytest-asyncio + xdist, vitest + Testing Library. Backend tests run against a real PostgreSQL 18 cloned per session from a migrated template (`tests/conftest.py`), auto-refreshed when the Alembic head changes.
- Both suites executed this run: **4,499 / 0 failed / 92%** and **3,894 / 0 failed / 80.8%** (see §1). No test modified the working tree.
- CI gates (`ci.yml`, one job): drift gates ×4, pip-audit, ruff check, ruff format, ty ×2, pytest, tagger precision gate, audit-ci, eslint, tsc + vite build, vitest, COOP/COEP guard, knip, Trivy. Plus CodeQL weekly and per-PR. That is 11 distinct quality classes.
- **IDE-committed profiles:** `.idea/inspectionProfiles/Project_Default.xml` only disables spell-checking; `.idea/` is otherwise untracked. No `.vscode/`, no `.editorconfig`. Every enforced tool is CI-enforced; there is no "configured but dead" tool except the size script noted in §4.1.
- The August flake (F-06) is fixed at the root: `frontend/vite.config.ts:48-51` sets `testTimeout`/`hookTimeout`, and `src/vitest.setup.ts:16-18` sets Testing Library's `asyncUtilTimeout` with a comment explaining it is a separate ceiling.
- Migrations: 122; 10 have no-op `downgrade()` (`20260322_…fix_time_control_bucket`, `20260403_200000_repair_bookmark_hashes`, `20260614_120000_…cleanslate`, `20260701_…suppress_ungated_tactic_tags`, +6). Nothing distinguishes "deliberately irreversible data repair" from "not written". Trade-off, not a defect; a one-line docstring per no-op would close it.
- Bus factor 1: 1,718 of 1,718 human commits in 90 days from one author.

### 4.7 Security

- Canonical probes: f-string SQL into `execute` — 3 hits, all `ALTER TYPE benchmark_metric ADD VALUE` migrations iterating a Python enum, not user input. Concatenated SQL — none in `app/`. CORS wildcard — none; CORS is only added when `ENVIRONMENT == "development"` (`app/main.py:270-278`). `send_default_pii=True` — none.
- Auth coverage: 73 routes, 69 declare an auth dependency in their signature; the 4 that don't are legitimately public (`auth.py:117` OAuth availability, `:305` guest create, `:386` OAuth callback, `push.py:95` VAPID public key). Remote-worker endpoints fail closed on a missing operator token. Passwords hashed with argon2 (pwdlib, `uv.lock:73`).
- **[bug] Client IP is a Cloudflare edge address since 2026-08-11.** Cloudflare proxies the site (`server: cloudflare`, `cf-ray` on every response; cutover recorded in commit `81d176e71`). `deploy/Caddyfile` configures no `trusted_proxies`, so Caddy sets `X-Forwarded-For` to its immediate peer — a Cloudflare anycast IP — and uvicorn (`deploy/entrypoint.sh:10`, `--proxy-headers --forwarded-allow-ips='*'`) faithfully exposes that as `request.client.host`. Confirmed in production: every `worker_heartbeats.last_ip` written after 2026-08-11 is in a Cloudflare range (`162.158.217.x`, `104.23.170.x`, `172.71.x.x`), whereas rows up to 2026-08-10 are real ISP/Hetzner addresses. Consequences: (1) the guest-creation limiter (`app/routers/auth.py:313-318`, 5 per hour per IP, `ip_rate_limiter.py:8-9`) now buckets every visitor behind the same Cloudflare edge together, so a handful of legitimate visitors on the Zurich PoP can 429 each other while an attacker rotating edges is not limited at all; (2) `last_ip`, which `app/models/worker_heartbeat.py:17-19` calls "the more trustworthy cross-check for fleet identity", is now meaningless. Fix (≈30 min): in the Caddyfile global block add `servers { trusted_proxies static <Cloudflare IPv4/IPv6 ranges>; client_ip_headers Cf-Connecting-Ip }` (Caddy ≥2.7; image is 2.11.4), which makes `{client_ip}` and the forwarded `X-Forwarded-For` carry the real client. The `Caddyfile:59` comment already mentions `Cf-Connecting-Ip` in the logging context, so the header's existence is known.
- **No security response headers in production** (unchanged, F-01 in August). `curl -I https://flawchess.com/` returns 10 headers, none of them HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy`; `deploy/Caddyfile` has 6 `header` directives and all set `Cache-Control` (`:100,105,112,128,141`). Cloudflare's dashboard could add HSTS, but nothing in the response shows it did. Compounds with the next item.
- 7-day JWT in `localStorage` (`app/users.py:156,285`; `frontend/src/hooks/useAuth.ts:64,101`), no revocation list. With no CSP, any XSS is a week-long session.
- In-process rate limiters (`app/core/ip_rate_limiter.py`, `feedback_rate_limiter.py`, `reset_password_rate_limiter.py`) reset on deploy and never evict keys — only timestamps within a key are pruned — so the dict grows by one entry per distinct IP/email forever. Bounded in practice by traffic, but a `del` on empty lists is a two-line fix.
- CVE tracking is explicit: `pyproject.toml:14` floors pydantic-ai at a CVE-fixed version; `ci.yml:67-78` documents both pip-audit ignores with reasons and revisit conditions.

### 4.8 Database design

- **FK discipline (DB-level via Alembic):** 29 `ForeignKey()` declarations in `app/models/`, **all 29** carry an explicit `ondelete`; 19 tables reference `users.id`, 17 with CASCADE, `benchmark_ingest_checkpoint.py:68` with `SET NULL` (intentional: audit rows outlive the selecting user), `oauth_account.py:15` with lowercase `"cascade"` (equivalent).
- 29 unique constraints / unique indexes, 26 check constraints. Natural composite PK on `game_positions` and `game_flaws`; `SmallInteger` for ply and enum-backed columns; partial indexes gated on ply (`game_position.py:74-120`).
- **Native enums contradict the house rule.** CLAUDE.md says "Avoid native PostgreSQL ENUM (evolving it is awkward and Alembic ignores enum changes)", yet `app/models/game.py:23-35` declares four `SAEnum(..., create_type=False)` (result, color, termination, TC bucket) and `user_benchmark_percentile.py:71` declares `benchmark_metric`; 10 migrations contain `ALTER TYPE … ADD VALUE` to evolve them, three of them via f-strings (`20260524_170733…:71`, `20260530_220134…:41`, `20260530_extend…:70`). The rule was written after these landed and says "align existing columns when you touch them"; the benchmark_metric enum has been touched three times without alignment.
- Migration count 122; 10 no-op downgrades (§4.6). `alembic/env.py` does not set `compare_type=True`, so autogenerate will not notice column-type drift — relevant given the enum rule.
- Timestamps: models import `DateTime` with `timezone=True` throughout (`app/models/base.py`); no naive `DateTime()` found.
- Hot-path query hygiene is monitored operationally via `pg_stat_statements` and the `db-report` skill (`reports/db-stats/`).

### 4.9 Frontend quality

- `frontend/tsconfig.app.json`: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedSideEffectImports` all on. `tsc -b` passes.
- `any`: 7 grep hits in non-test, non-generated source, **all inside comments** (e.g. `ScoreChart.tsx:155` explaining a recharts type). 0 `@ts-ignore` / `@ts-expect-error`.
- Accessibility: 219 `aria-label`, 0 `<div onClick>`, every `<img>` spot-checked carries `alt` (`Home.tsx:311-314`). 933 `data-testid` in non-test source.
- Theme: hex literals outside `theme.ts`/CSS are brand SVG fills (Google button, `RegisterForm.tsx:27-39`, `LoginForm.tsx:169`) plus 4 real leaks: `Home.tsx:410,436,437` (`#1a1a1a`) and `MaiaMoveQualityBar.tsx:566` (`#1a1a1a`/`#ffffff`). **[quick win]** replace with a token.
- 107 `text-xs` occurrences against the stated `text-sm` minimum (down from 118). Spot-checked: most are tooltip/badge contexts the rule exempts.
- Dead exports gated by knip in CI (`ci.yml:178`); eslint gates `complexity`/`max-depth`/`max-statements` at `error` with a baseline (`frontend/CLAUDE.md`).
- Largest components: `Analysis.tsx` 2,761, `TrainReveal.tsx` 1,365, `EvalChart.tsx` 1,311, `LibraryGameCard.tsx` 1,299, `TrainSolveScreen.tsx` 1,214 — each past the 200-logic-LOC guideline, but the accepted-residual list in CLAUDE.md and the Phase 215 record show this is tracked, not ignored.

### 4.10 Observability

- Canonical probes: Sentry capture sites 167; `sentry_sdk.init`/`Sentry.init` in 2 apps of 2 (backend `app/main.py:253`, frontend `frontend/src/instrument.ts`) = 100%. Correlation-ID plumbing (`request_id|trace_id|correlation_id|X-Request-Id`): **0** sites in `app/` and `frontend/src`. JSON logger: none in Python.
- **Fixed since August (F-10, partly):** `app/main.py:96-121` now raises the `app` logger tree to INFO and attaches a `StreamHandler`, with a 20-line comment explaining why both halves were necessary (uvicorn adds no root handler, so INFO fell through to `lastResort`). Format is still the plain `"%(levelname)s: %(name)s - %(message)s"` (`:118`), not structured.
- Caddy now writes a JSON access log to stdout with request headers deleted and reset tokens redacted (`deploy/Caddyfile:31-74`), skipped for static assets, rotated by Docker at 50 MB (`docker-compose.yml:157-160`). This closes the "502 during deploy leaves no trace" gap the file cites (FLAWCHESS-64).
- `/api/health` returns `{"status": "ok"}` without touching the database (`app/main.py:304-306`), so the post-deploy health loop (`ci.yml:240-250`) passes while Postgres is still migrating or down. **[quick win]** add a `SELECT 1`.
- No off-box log retention, no metrics endpoint; Sentry is the durable record. Umami provides product analytics (`docker-compose.yml:122`).

### 4.11 Performance

- N+1: the `for … await session.execute` pattern appears once in `app/` and it is a deliberate chunked UPDATE (`eval_drain.py:1319`, `_RESWEEP_UPDATE_CHUNK_SIZE`). Repositories use explicit joins.
- Async safety: `asyncio.gather` is used exactly once on a session-free path (`email_service.py:146`); ten docstrings and comments across `imports.py`, `endgames.py`, `eval_queue_service.py`, `insights_llm.py`, `eval_entry.py` explicitly state "sequential awaits, never gather". No `requests`, no `time.sleep` in `app/`.
- Batching: games committed in batches of 30 (`import_service.py:87`, with the OOM incident that set the number recorded at `:74-86`); positions COPY'd in 1,700-row chunks (`game_repository.py:25`); backward lichess fetch chunked at 200 (`:123`).
- OOM containment: `mem_limit`/`memswap_limit` on every container (`docker-compose.yml:61-62,114-115,129`), `shm_size` for Postgres.
- Frontend engine work is fully off-main-thread (Web Workers, `frontend/src/lib/engine/workerPool.ts`) with a watchdog for dead slots (`workerPoolWatchdog.ts`).
- Not verified: no load-test or profiling artifacts in the repo; `reports/import-stress-test/` covers import throughput only.

### 4.12 Disaster recovery and backups

- Backup mechanism: Hetzner daily server snapshot, 7-day rolling, offsite (`README.md:281-291`). That is one layer.
- Missing: logical `pg_dump` (would survive a corrupting bug noticed after day 7), WAL archiving / PITR, a written restore runbook (none in `docs/production-runbook.md`), a tested restore, an RTO.
- Grade stays **C**: a backup exists and is offsite, so not D; nothing else on the ladder is ticked. Effort to reach B: a nightly `pg_dump | gzip` to a Hetzner Storage Box via cron plus a `docs/restore-runbook.md` with one dry run recorded — half a day.

### 4.13 Data privacy and GDPR/FADP

- Privacy page is honest and prerendered (`frontend/src/pages/Privacy.tsx`), states cookie-free Umami analytics (`:53`), and lists deletion as an email request (`:58-68`). No consent checkbox on signup (`RegisterForm.tsx` has no privacy/terms reference), which for a free service with no marketing use is defensible but worth a link.
- Erasure path: DB-level CASCADE on 17 of 19 user-FK tables (§4.8) plus an audited application purge for guests (`app/services/guest_cleanup_service.py:64-117`, re-verifies eligibility inside the transaction, covers `import_jobs`, percentiles, rating anchors, drill rows). For a registered user the same plumbing exists but **no endpoint or CLI calls it**: only two `@router.delete` routes exist repo-wide (`imports.py:497` delete games, `position_bookmarks.py:184`), and `admin.py` has no delete-user route. Erasure is therefore a manual SQL `DELETE FROM users` by the operator.
- Data export: none (no export route in 16 routers).
- `llm_logs.user_prompt` stores the full prompt text per user (`app/models/llm_log.py:59`) — it is aggregated game statistics, not free text, but it is user-linked and should be in the deletion scope (it is, via CASCADE).
- PII to third parties: `send_default_pii=False` on both Sentry SDKs; Caddy drops all request headers from logs including `Cf-Connecting-Ip` (`Caddyfile:59`).

### 4.14 Dependency management and supply chain

- **Automation — configured but dead [bug].** `renovate.json` (weekly Monday schedule, grouped minor/patch, lockfile maintenance, vulnerability alerts) landed in commit `4c615ced0` on 2026-04-20 and the README carries a "renovate enabled" badge. `git log --all` contains **zero** Renovate-authored commits and `gh pr list --state all` shows **zero** Renovate PRs in 4½ months; the only bot PRs are Dependabot *security* updates (`#336`, `#307`, `#136`, …). No `.github/dependabot.yml` exists, so Dependabot version updates are not configured either. Net effect: routine updates are manual, and `npm outdated` shows 27 packages behind their `wanted` range (e.g. `@sentry/react` 10.55→10.73, `vite` 8.0.16→8.2.2, `axios` 1.18→1.20, `eslint` 10.4→10.9) plus 2 majors (vitest 5, TypeScript 7); `uv pip list --outdated` shows 15 Python packages, none of them direct runtime deps. Fix: either install the Renovate GitHub App on the `flawchess/flawchess` repo (the config is already correct) or add a `dependabot.yml` for `pip`/`npm`/`github-actions`/`docker`.
- **Lockfiles:** `uv.lock` + `frontend/package-lock.json` committed; `uv sync --locked` (`ci.yml:45`) and `npm ci` (`:130`).
- **Audit tooling in CI:** pip-audit `--strict` with two documented ignores (`ci.yml:67-78`), audit-ci with a justified allowlist (`frontend/audit-ci.jsonc`), Trivy HIGH/CRITICAL on the built image (`:186-192`), CodeQL.
- **Base images:** all five Python `FROM` lines digest-pinned (`Dockerfile:1,22`, `Dockerfile.worker:19,34,68`); `frontend/Dockerfile:1` `node:24-alpine` and `:13` `caddy:2.11.4` by tag only. **[quick win]** pin both by digest.
- **Over-pinning probe:** no `requirements*.txt`; `pyproject.toml` uses ranges except the two documented exact pins (onnxruntime, `stockfish` npm). Clean.
- Transitive CVE exposure: `frontend/package.json:79-90` carries 10 `overrides` for patched transitives, each traceable to a Dependabot alert (commit `37a7cb88b`).

### 4.15 Frontend bundle and performance

- **Production bundle size** (existing `frontend/dist/` from 2026-09-04 14:46): entry `index-DVzc_wSe.js` 1,407,875 B raw / **408,303 B gzipped**; `HorizontalMoveList-…js` 59 KB gz; `Analysis-…js` 31 KB gz; CSS 22 KB gz; `dist/` 95 MB total dominated by the Maia ONNX model and Stockfish WASM under `public/`.
- **Code splitting:** 5 `lazy()` route boundaries (Analysis, Bots, Train, EloSelector chunks visible in `dist/assets/`). Recharts and react-chessboard are in the entry chunk; both are needed on the first authenticated screen, so splitting them buys little.
- **Heavy runtime assets:** 44 MB WASM/ONNX served from `public/` with a 30-day `Cache-Control` and the worker glue at `no-cache` (`Caddyfile:110-128`) — the right split.
- **Preconnect:** Google Fonts preconnects present (`frontend/index.html:6-7`). No `<meta http-equiv="Content-Security-Policy">` either (see §4.7).
- **Source maps:** `vite.config.ts` sets no `build.sourcemap`, so none ship. Frontend Sentry stack traces are therefore minified unless uploaded separately; not verified either way.
- Grade **B**: 408 KB gz entry is heavy for a mobile-first PWA but is unchanged since August (403 KB), so growth is controlled.

### 4.16 CI/CD execution speed

- **Observed duration:** last 5 successful `main` PR runs: 490, 518, **529 (median)**, 535, 567 s → **8 m 49 s** median. Production `workflow_dispatch` runs ≈ 10 m including deploy + health check. Two 1-minute failures on 2026-09-02 were fast-fail lint drift, which is the gate working.
- **Parallelization:** single job, sequential steps; pytest runs serially in CI by design (`README.md:246`, "deterministic, bisectable logs"); vitest uses its default worker pool.
- **Dependency caching:** none. `actions/setup-python@v6` (`ci.yml:35`) has no `cache:` input, uv is `pip install`ed fresh (`:39`), `actions/setup-node@v6` (`:125`) has no `cache: npm`. The 4 drift-gate steps and the Stockfish download are also uncached. **[quick win]** `astral-sh/setup-uv@v5` with `enable-cache: true` + `setup-node` `cache: npm` — ≈30 min, ≈1–2 min saved per run.
- **Deploy:** `docker compose build --no-cache backend caddy` on every release (`ci.yml:236`); with digest-pinned bases `--no-cache` mostly rebuilds identical layers.

### 4.17 Technical debt and legacy stack

- **Runtimes:** Python 3.13 (`.python-version`, `requires-python >= 3.13`), Node 24 (`ci.yml:127`, `frontend/Dockerfile:1`), PostgreSQL 18, Caddy 2.11.4 (bumped 2026-09-04).
- **Frameworks vs latest:** React 19.2, react-router 8.3, TanStack Query 5, Tailwind 4.3, Vite 8.0 (8.2 available), TypeScript 6.0 (7.0 released; `~6.0.3` pin is deliberate), Vitest 4.1 (5.0 released), FastAPI 0.115, SQLAlchemy 2, Pydantic 2.13, pydantic-ai 2.x (upgraded 2026-08-16).
- **Legacy exposure:** none. 0 class components, no moment/jquery/lodash, no `asyncio.get_event_loop()`, no `utcnow()`, no `@app.on_event`.
- **Dependency maintenance status:** `npm outdated` + `uv pip list --outdated` run this session — all drift is minor/patch except vitest 5 / TypeScript 7 / jsdom 30 majors; no archived or registry-deprecated direct dependency found on spot-check (`stockfish` npm is version-pinned to a vendored binary with its license documented in README).
- **Deprecated APIs in use:** none found.
- **Build tooling:** uv, Vite 8, ruff, ty, knip, complexipy — current.
- **Blocked upgrades:** `onnxruntime==1.20.1` (segfault on the vendored model above 1.22, `pyproject.toml:37-42`, with a re-verification script named); `onnxruntime-web` 1.27.0 exact (paired with the vendored runtime under `public/maia/`); `typescript ~6.0.3`. All three carry reasons.

---

## 5. Findings Register

**Severity**: Critical = production-blocking or data-loss risk; High = likely to cause incidents within 3 months; Medium = real risk but bounded; Low = minor quality/hygiene.
**Confidence**: Verified / Likely / Inferred.
**Effort**: ≤1h / half-day / 1d / >1d.

| ID | Dimension | Finding | Severity | Confidence | Evidence | Effort |
|---|---|---|---|---|---|---|
| F-01 | Security | Behind Cloudflare (since 2026-08-11) `request.client.host` is a Cloudflare edge IP: guest-creation rate limiter buckets unrelated visitors together and worker `last_ip` is meaningless; no `trusted_proxies` in Caddy | High | Verified | `deploy/Caddyfile` (no `trusted_proxies`), `deploy/entrypoint.sh:10`, `app/routers/auth.py:313-318`; prod `worker_heartbeats.last_ip` all in `162.158/104.23/172.71` ranges after 2026-08-11 | ≤1h |
| F-02 | Security | Production serves no security response headers (HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`, frame-ancestors) | High | Verified | `curl -I https://flawchess.com`; `deploy/Caddyfile:100,105,112,128,141` (all `Cache-Control`) | ≤1h |
| F-03 | Dependency mgmt | Renovate configured but has never run: zero Renovate PRs/commits since `renovate.json` landed 2026-04-20; no `dependabot.yml`; 27 npm packages behind `wanted` | High | Verified | `renovate.json`; `git log --all` grep renovate = 2 human commits; `gh pr list --state all` = 0 Renovate PRs; `npm outdated` | ≤1h |
| F-04 | Security | 7-day JWT in `localStorage`, no revocation; compounds with F-02 | High | Verified | `app/users.py:156,285`; `frontend/src/hooks/useAuth.ts:64,101` | >1d |
| F-05 | Data privacy | No self-service or admin account deletion; GDPR Art. 17 erasure is a manual SQL delete despite CASCADE + purge plumbing existing | High | Verified | `Privacy.tsx:58-68`; only 2 `@router.delete` routes (`imports.py:497`, `position_bookmarks.py:184`); `admin.py` has no delete | half-day |
| F-06 | Disaster recovery | No logical `pg_dump` layer; 7-day snapshot is the only backup | High | Verified | `README.md:281-291`; no backup script in `bin/` | half-day |
| F-07 | Disaster recovery | No restore runbook and no tested restore; RTO undefined | Medium | Verified | `docs/production-runbook.md` has no restore section; `README.md:283` console-only | half-day |
| F-08 | CI/CD speed | Zero dependency caching in CI; 8 m 49 s median | Medium | Verified | `ci.yml:35,39,125` (no `cache:` / setup-uv) | ≤1h |
| F-09 | Architecture | Project's "hard 4" nesting limit breached by 8 functions (two at depth 7) and `check_function_size.py` runs nowhere in CI or the pre-merge gate | Medium | Verified | `scripts/check_function_size.py app/` output; `lichess_client.py:51`, `user_benchmark_percentiles_service.py:505`; `ci.yml`, CLAUDE.md pre-merge gate | ≤1h to gate, 1d to fix |
| F-10 | Architecture | `app/routers/eval_remote.py` is a 1,563-LOC router with 10 inline `session.execute`, an undocumented exception to "no SQL in routers" | Medium | Verified | `rg -c 'session\.execute\(' app/routers/eval_remote.py` = 10 | >1d |
| F-11 | Observability | Plain-text log format, no request-correlation ID, no off-box log retention | Medium | Verified | `app/main.py:118`; 0 hits for `request_id|correlation_id|X-Request-Id` in `app/` | half-day |
| F-12 | Observability | `/api/health` never touches the DB, so the deploy health loop can pass with Postgres down | Medium | Verified | `app/main.py:304-306`; `ci.yml:240-250` | ≤1h |
| F-13 | Data privacy | No data-export endpoint (Art. 20) | Medium | Verified | No export route across 16 routers | half-day |
| F-14 | Database design | 5 native PG enums + 10 `ALTER TYPE … ADD VALUE` migrations contradict the CLAUDE.md "avoid native ENUM" rule; `compare_type` not enabled in `alembic/env.py` | Low | Verified | `app/models/game.py:23-35`, `user_benchmark_percentile.py:71`; migrations `20260524_170733…:71` et al. | 1d |
| F-15 | Frontend bundle | 408 KB gzipped entry chunk | Medium | Verified | `frontend/dist/assets/index-DVzc_wSe.js` 1,407,875 B raw / 408,303 B gz | 1d |
| F-16 | Dependency mgmt | `node:24-alpine` and `caddy:2.11.4` by floating tag while Python bases are digest-pinned | Low | Verified | `frontend/Dockerfile:1,13` vs `Dockerfile:1,22` | ≤1h |
| F-17 | Security | In-process rate limiters never evict keys (unbounded dict growth per distinct IP/email) and reset on deploy | Low | Verified | `app/core/ip_rate_limiter.py` (no `del`/`pop`), `feedback_rate_limiter.py`, `reset_password_rate_limiter.py` | ≤1h |
| F-18 | Secrets / config | 4 `Settings` fields missing from `.env.example` | Low | Verified | `app/core/config.py` vs `.env.example`: `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`, `BENCHMARK_SELECTION_GATE_ENABLED`, `BEST_MOVE_BACKFILL_ENABLED`, `OAUTH_TUNNEL_ORIGINS` | ≤1h |
| F-19 | Code smells | Orphan 97 MB worktree directory no longer registered with git | Low | Verified | `.claude/worktrees/agent-a740fb7ec554451f9`; `git worktree list` | ≤1h |
| F-20 | Frontend quality | 4 hex literals outside `theme.ts` | Low | Verified | `Home.tsx:410,436,437`, `MaiaMoveQualityBar.tsx:566` | ≤1h |
| F-21 | Maintainability | 10 of 122 migrations have no-op `downgrade()` with nothing marking them as deliberately irreversible | Low | Verified | `20260322_135825…`, `20260614_120000…`, +8 | ≤1h |
| F-22 | Maintainability | Bus factor 1 | Medium | Verified | `git shortlog` 90 days: 1,718 / 1 author | >1d |
| F-23 | Code smells | 12 of 25 `exhaustive-deps` disables carry no written rationale | Low | Likely | `AnalysisTagsPanel.tsx:116-252` (7), `useAnalysisRouteSeeding.ts:168-265` (5) | half-day |

---

## 6. Substantial Problems Worth Addressing

1. **Restore real client IPs behind Cloudflare.** Since the 2026-08-11 CDN cutover every request reaches uvicorn with a Cloudflare anycast address as `client.host`, because Caddy has no `trusted_proxies` and forwards its immediate peer. The guest-creation limiter (5/hour/IP) therefore shares one bucket across everyone on the same edge, and `worker_heartbeats.last_ip` — documented as the trustworthy fleet-identity cross-check — records only Cloudflare ranges (verified in prod). Add a Caddy global `servers { trusted_proxies static <Cloudflare ranges>; client_ip_headers Cf-Connecting-Ip }` block and re-check `last_ip` after the next deploy. *(effort: ≈30 min, maps to F-01)*
2. **Add security response headers in the Caddyfile.** One `header` block on the `flawchess.com` site: `Strict-Transport-Security "max-age=31536000; includeSubDomains"`, `X-Content-Type-Options nosniff`, `Referrer-Policy strict-origin-when-cross-origin`, `Permissions-Policy`, and a CSP with `frame-ancestors 'none'` at minimum (a full CSP needs `worker-src`/`wasm-unsafe-eval` for the engine and Google OAuth allowances — start with report-only). Extend the CI COOP/COEP guard to assert the new headers are present. *(effort: ≈1 h, maps to F-02, mitigates F-04)*
3. **Make dependency automation actually run.** `renovate.json` is correct but the Renovate app has never opened a PR in 4½ months; only Dependabot security PRs exist. Either install the Renovate GitHub App on the repo, or delete `renovate.json` and add `.github/dependabot.yml` covering `pip`, `npm` (`/frontend`), `github-actions`, and `docker` on a weekly schedule. Then remove the README badge that currently misstates the situation. *(effort: ≈30 min, maps to F-03)*
4. **Wire a self-service account-deletion endpoint.** `DELETE /api/users/me` calling the existing `delete_all_games_for_user` + the guest-purge steps (`guest_cleanup_service.py:64-117`) and then `DELETE FROM users` with CASCADE doing the rest; a confirmation dialog in Settings; update `Privacy.tsx:58-68`. A data-export endpoint (games as PGN + a JSON of settings) is a natural follow-on. *(effort: half-day, maps to F-05, F-13)*
5. **Add a logical backup layer and a restore runbook.** Nightly `docker compose exec db pg_dump -Fc | gzip` to a Hetzner Storage Box (or Backblaze B2) with 30-day retention, plus `docs/restore-runbook.md` describing both snapshot restore and `pg_restore`, with one recorded dry run. Consider enabling `archive_mode` for PITR later. *(effort: half-day, maps to F-06, F-07)*
6. **Shorten the auth exposure window.** Reduce the registered-user JWT from 7 days to hours and add a refresh path, or at least a server-side denylist keyed on `jti`; keep the guest 30-day token. Do this after item 2 so the CSP covers the XSS half. *(effort: >1d, maps to F-04)*
7. **Gate the function-size rule and fix the depth-7 functions.** Add `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` to CI and the CLAUDE.md pre-merge gate with the 8 current breaches baselined; then flatten `lichess_client.py:51` and `user_benchmark_percentiles_service.py:505` (both depth 7) with early `continue`s. *(effort: ≤1h to gate, 1d to fix, maps to F-09)*
8. **Make `/api/health` prove the database.** `await session.execute(text("SELECT 1"))` with a 2 s timeout, returning 503 on failure; the deploy health loop then means what it says. *(effort: ≤1h, maps to F-12)*

---

## 7. What's Notably Good

- **Zero unresolved production Sentry issues in 14 days** on a product shipping ≈19 commits/day, backed by an explicit practice of hunting swallowed exceptions (commit `7fc994cf7`) and a `before_send` that keeps transient DB drops to one fingerprint (`app/main.py:73-88`).
- **Per-run cloned PostgreSQL template databases** (`tests/conftest.py`) let 4,499 integration tests over a real Postgres finish in 103 s locally, and they auto-refresh when the Alembic head moves — no manual rebuild step.
- **Universal `ondelete` on all 29 foreign keys** at the DB layer, natural composite PKs on the two hot tables, and partial indexes gated on `ply` — the schema pays the Zobrist bet's cost on purpose.
- **Generated-file drift gates** (`ci.yml:48-65`): four TS files regenerated from Python in CI and diffed, so thresholds cannot silently fork between languages.
- **Comments that record why, with pointers to the evidence** — the onnxruntime pin (`pyproject.toml:37-42`), the import batch size and the OOM that set it (`import_service.py:74-87`), the Caddy log redaction that failed twice (`Caddyfile:55-62`), the logging bug that hid `maia_engine` diagnostics (`app/main.py:96-121`). A new maintainer inherits the reasoning, not just the numbers.
- **Supply-chain gates in CI** — pip-audit `--strict`, audit-ci with a justified allowlist, Trivy on the built image, CodeQL, digest-pinned Python bases, lockfiles enforced — with every ignore documented and given a revisit condition.
- **Frontend type discipline**: `strict` + `noUncheckedIndexedAccess`, 0 `any`, 0 `@ts-ignore`, knip in CI, 933 `data-testid`, 0 `console.error` in source.
- **Honest ops documentation**: `README.md:281-291` states the backup gap rather than papering over it; the Cloudflare cutover runbook records what went wrong during the cutover (`docs/cloudflare-cdn-cutover-runbook.md:695-716`).

---

## 8. Recommended Actions

### Immediate (this week — small, high signal)

1. **Fix client IP behind Cloudflare** — Caddy `trusted_proxies` + `client_ip_headers Cf-Connecting-Ip`; verify with `worker_heartbeats.last_ip` after deploy. ≈30 min. (F-01)
2. **Security headers in the Caddyfile** + extend the CI header guard. ≈1 h. (F-02)
3. **Install the Renovate app or switch to `dependabot.yml`**; fix the README badge. ≈30 min. (F-03)
4. **CI caching**: `astral-sh/setup-uv` with cache, `setup-node` `cache: npm`. ≈30 min, ≈1–2 min/run. (F-08)
5. **Housekeeping quick wins**: delete the 97 MB orphan worktree (F-19); add the 4 missing `.env.example` keys (F-18); digest-pin `node:24-alpine` and `caddy:2.11.4` (F-16); replace the 4 hex literals (F-20); `del` empty limiter keys (F-17). ≈1 h total.
6. **`/api/health` DB probe.** ≈30 min. (F-12)
7. **Gate `check_function_size.py`** in CI / pre-merge with today's 8 breaches baselined. ≈30 min. (F-09)

### Short term (this month — quality-of-life)

8. **Self-service account deletion** (+ privacy page update), then data export. Half-day each. (F-05, F-13)
9. **Nightly `pg_dump` offsite + restore runbook with one dry run.** Half-day. (F-06, F-07)
10. **Docstring the 10 no-op downgrades** as deliberately irreversible, and set `compare_type=True` in `alembic/env.py`. ≤1 h. (F-21, F-14)
11. **Add one-line rationale to the 12 un-justified `exhaustive-deps` disables**, or fix the dependency. Half-day. (F-23)
12. **Structured JSON logging + `X-Request-Id` middleware** stamped onto log records and Sentry scope. Half-day. (F-11)

### Medium term (next quarter — only if needed)

13. **Dependency updates (Renovate / Dependabot)** — already covered by action 3; once automation runs, take the vitest 5 / TypeScript 7 majors in their own PRs.
14. **JWT lifetime + refresh/denylist.** >1 d. (F-04)
15. **Retire the native PostgreSQL enums** on `games` and `user_benchmark_percentiles` per the house rule, one column per migration. 1 d. (F-14)
16. **Split `eval_remote.py`** lease/submit SQL into a repository or document it as the sanctioned exception. >1 d. (F-10)
17. **Entry-chunk diet**: measure what a `manualChunks` split of recharts and react-chessboard buys on the first authenticated route; only act if >80 KB gz. 1 d. (F-15)
18. **Bus factor**: a `docs/onboarding.md` that walks the eight steps in §3 with the key file per step would cut a second contributor's ramp-up to days. (F-22)

---

## 9. Bottom Line

FlawChess is a production-grade codebase that has improved measurably in the four weeks since the last assessment: both test suites are larger and fully green (4,499 and 3,894), the frontend flake and the silent-logger bug are fixed at the root, the largest god-file lost a third of its weight, and Sentry shows nothing open in production. Anyone reading it top-to-bottom should expect a documented convention that is actually followed, schema and supply-chain discipline well above the norm for a single-maintainer project, and comments that explain decisions rather than restate code. The two new findings are the important ones precisely because they are silent: the Cloudflare cutover replaced every client IP the backend sees, and the Renovate badge describes automation that has never run. Both are sub-hour fixes. The three persistent gaps — no security headers, email-only erasure, an untested 24-hour-RPO backup — are also cheap and are the difference between "excellent hobby-scale ops" and "would pass a due-diligence review". There is no rewrite hiding here; this is make-a-good-thing-better territory with a short, concrete list.
