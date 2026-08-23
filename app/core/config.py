from typing import Literal

from dotenv import load_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict

# Populate os.environ from .env so third-party libraries that read provider
# API keys directly (e.g. pydantic-ai's GoogleProvider reading GOOGLE_API_KEY)
# can see them. pydantic-settings only loads .env into the Settings object,
# not into the process environment.
load_dotenv()

# Insecure placeholder SECRET_KEY. Booting a non-development environment with this
# value is a deploy-blocker (see assert_secret_key_configured); JWTs signed with a
# publicly-known key are trivially forgeable.
DEFAULT_SECRET_KEY = "change-me-in-production"


class Settings(BaseSettings):
    # DATABASE_URL is what the running app (and Alembic) connect to. The four
    # DATABASE_URL_* variants are the single source of truth for the per-target
    # URLs used by maintenance scripts that take a `--db dev|benchmark|prod`
    # flag; resolve them via db_url_for_target() rather than port-swapping
    # DATABASE_URL. All are reached over localhost (dev/benchmark via Docker,
    # prod via the SSH tunnel from bin/prod_db_tunnel.sh). Override in .env.
    DATABASE_URL: str = "postgresql+asyncpg://flawchess:flawchess@localhost:5432/flawchess"
    DATABASE_URL_DEV: str = "postgresql+asyncpg://flawchess:flawchess@localhost:5432/flawchess"
    DATABASE_URL_TEST: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/flawchess_test"
    DATABASE_URL_PROD: str = "postgresql+asyncpg://flawchess:flawchess@localhost:15432/flawchess"
    DATABASE_URL_BENCHMARK: str = "postgresql+asyncpg://flawchess_benchmark:flawchess_benchmark@localhost:5433/flawchess_benchmark"
    DB_ECHO: bool = False
    SECRET_KEY: str = DEFAULT_SECRET_KEY
    GOOGLE_OAUTH_CLIENT_ID: str = ""
    GOOGLE_OAUTH_CLIENT_SECRET: str = ""
    BACKEND_URL: str = "http://localhost:8000"
    # Frontend base URL — used to build OAuth redirect back to SPA
    FRONTEND_URL: str = "http://localhost:5173"
    # Same-origin dev tunnels (Tailscale/ngrok) allowed to drive the Google OAuth
    # round-trip, in addition to FRONTEND_URL. Comma-separated origins. For these
    # the SPA and /api share one HTTPS host, so the OAuth redirect base == origin.
    OAUTH_TUNNEL_ORIGINS: str = ""
    # "development" enables CORS for localhost:5173 and drops the Secure flag on auth cookies (so cookies work over plain HTTP in local dev)
    ENVIRONMENT: str = "production"
    SENTRY_DSN: str = ""  # Empty string = Sentry disabled (dev default)
    SENTRY_TRACES_SAMPLE_RATE: float = 0.0  # 0.0 = no traces (dev default)

    # Pydantic-AI model string for endgame insights (Phase 65). Empty string
    # is treated as "unconfigured" — app/main.py lifespan calls
    # get_insights_agent() which raises UserError on the empty string, aborting
    # startup (D-22/D-23). Accepts any pydantic-ai model string, e.g.
    # "anthropic:claude-haiku-4-5-20251001", "google:gemini-3.5-flash".
    # Tests use the built-in "test" provider (see tests/conftest.py).
    PYDANTIC_AI_MODEL_INSIGHTS: str = ""
    # When true, insights service strips `report.overview = ""` before
    # returning to client. Full overview still persists in llm_logs.response_json
    # for offline analysis — log is source of truth, response is policy-gated
    # view (D-18, BETA-02).
    INSIGHTS_HIDE_OVERVIEW: bool = False

    # Google Gemini thinking controls. Only applied when PYDANTIC_AI_MODEL_INSIGHTS
    # starts with "google:" or "google-cloud:". Silently ignored for other
    # providers (Anthropic, OpenAI, test).
    #
    # GEMINI_THINKING_LEVEL:  Gemini 3+ knob — "minimal", "low", "medium", or
    #   "high", in increasing reasoning depth / token cost / latency. "minimal"
    #   is the cheapest/fastest (Google's equivalent of the old 2.5
    #   thinking_budget=0). Gemini 3.5's own default is "medium"; we default to
    #   "low" to keep insights cheap and fast.
    # GEMINI_THINKING_BUDGET: Gemini 2.5 knob — explicit token cap. 0 disables
    #   thinking entirely. Ignored on Gemini 3 (which uses thinking_level).
    # GEMINI_INCLUDE_THOUGHTS: when True, Google returns thoughts_token_count in
    #   usage metadata so the insights service can persist them to
    #   llm_logs.thinking_tokens for cost attribution.
    GEMINI_THINKING_LEVEL: Literal["minimal", "low", "medium", "high"] = "low"
    GEMINI_THINKING_BUDGET: int = 0
    GEMINI_INCLUDE_THOUGHTS: bool = True

    # Automatic background full-eval toggle (Phase 117). When False, the tier-3
    # idle-backlog derived pick is suppressed — the only automatic eval source as of
    # Phase 118, which removed the tier-2 auto-window enqueue. Tier-1 (explicit,
    # on-demand single-game request) is UNAFFECTED — on-demand analysis still works.
    # Default False (safe for dev/CI so a local backend doesn't pin every core on the
    # hundreds-of-thousands-game backlog). Prod opts in explicitly via its .env.
    EVAL_AUTO_DRAIN_ENABLED: bool = False

    # Best-move backfill toggle (Phase 176 BACK-01, D-05). When False (default),
    # the tier-4b spare-capacity lottery is suppressed even when
    # EVAL_AUTO_DRAIN_ENABLED is True (BOTH gates are checked — see
    # claim_eval_job's bundled scope=None path). Independent from
    # EVAL_AUTO_DRAIN_ENABLED so prod can pause best-move backfill without
    # disabling all idle drain. Phase 177 BACK-02/03 added a dedicated
    # /bestmove-lease + /bestmove-submit endpoint pair (mirroring the flaw-blob
    # isolation pattern), so best-move backfill IS now shed-able to the remote
    # worker fleet — this flag gates BOTH the in-process backend drain AND the
    # worker-facing lease endpoint (single switch, D-04), not just backend load.
    # Default False; enable in prod deliberately after observing backend
    # RSS/CPU (mirrors 174 D-03b's posture). Do NOT enable in prod as part of
    # this merge — it is a separate, observed flag flip.
    BEST_MOVE_BACKFILL_ENABLED: bool = False

    # Benchmark full-game-analysis lane selection gate (Phase 212 BENCHLANE-02,
    # D-09). When True, every lottery/claim lane the worker fleet can reach --
    # tier-3 derived, tier-4 blob, tier-4b bestmove (eval_queue_service.py), and
    # the entry-ply probe + canonical claim (eval_remote.py / eval_entry.py,
    # 212-07, which also covers the in-process server-pool drain since it shares
    # the same claim) -- narrows its candidate query to games present in
    # benchmark_selection. See app/services/eval_utils.py's selection_gate_clause().
    # The explicit tier-1/2 queue (eval_jobs) is deliberately NOT gated: it is fed
    # only by explicit user-requested enqueue, never a lottery, and is out of reach
    # on the benchmark instance for a structural reason (no enqueue surface there) --
    # see docs/benchmark-lane-runbook.md's per-rung table. This flag exists ONLY
    # for the benchmark backend instance running on :8001 against the benchmark
    # Postgres on :5433. Unlike
    # EVAL_AUTO_DRAIN_ENABLED and BEST_MOVE_BACKFILL_ENABLED above (which prod
    # DOES enable), prod's .env must NEVER set this true -- doing so would
    # silently change what prod's lottery claims, gating prod's live traffic
    # against a benchmark-only table that does not exist on prod's DB. Default
    # False (safe for dev/CI/prod).
    BENCHMARK_SELECTION_GATE_ENABLED: bool = False

    # Eval-source homogenization for the benchmark full-game-analysis lane
    # (Phase 212 BENCHLANE-05, D-03). When True, the derived
    # is_lichess_eval_game boolean is forced False everywhere it is computed
    # (see app/services/eval_utils.py's derive_is_lichess_eval_game -- the
    # SINGLE derivation point all seven call sites route through). This makes
    # the drain write path store our own engine's eval_cp instead of
    # preserving lichess's, restores the terminal eval donor
    # (include_terminal=not is_lichess_eval_game in eval_drain.py), and lets
    # game_flaws classify from our Stockfish rather than lichess's imported
    # evals -- so a §6-style analyzed-vs-unanalyzed comparison is not
    # confounded by eval source. games.lichess_evals_at itself is
    # deliberately left untouched by this flag and remains the §6 selection
    # marker (D-04) -- only the derived boolean is overridden. Accepted
    # knock-on: this also drops the eval_drain.py best-move identity-key
    # substitution that keeps lichess's stored best_move as the candidate
    # identity key, so the engine's own best move becomes the identity key
    # instead -- which is the intended, more correct behavior. Like
    # BENCHMARK_SELECTION_GATE_ENABLED above, this flag exists ONLY for the
    # benchmark backend instance; prod's .env must NEVER set this true.
    # Default False (safe for dev/CI/prod).
    BENCHMARK_HOMOGENIZE_EVAL_SOURCE: bool = False

    # Operator token for the remote eval worker (Phase 120 SEED-048).
    # Empty string = endpoints return 403 (disabled in dev/CI).
    # Prod sets a strong random secret in .env.
    EVAL_OPERATOR_TOKEN: str = ""

    # Operator token the remote eval worker presents to its FALLBACK backend
    # (Phase 212 D-13), i.e. the benchmark instance's own EVAL_OPERATOR_TOKEN.
    # Read ONLY by scripts/remote_eval_worker.py as the default for
    # --fallback-token; no backend ever reads this name, so unlike the benchmark
    # gate flags it is safe to keep in .env -- a dev backend loading the same
    # .env is unaffected by it. Empty = no default, so --fallback-token (or,
    # failing that, the primary token) applies as before.
    EVAL_FALLBACK_OPERATOR_TOKEN: str = ""

    # The benchmark :8001 instance's OWN operator token (Phase 212). Read by
    # bin/run_benchmark_backend.sh, which passes it as that process's
    # EVAL_OPERATOR_TOKEN on the command line; declared here so it is documented
    # alongside the other two rather than being an undeclared .env key. No
    # backend reads this name directly, so -- like EVAL_FALLBACK_OPERATOR_TOKEN
    # and unlike the BENCHMARK_* flags -- it is safe to keep in .env. Worker
    # boxes present the same value as EVAL_FALLBACK_OPERATOR_TOKEN.
    EVAL_BENCHMARK_OPERATOR_TOKEN: str = ""

    # Expected Stockfish version string (Phase 120 D-5 version gate).
    # e.g. "Stockfish 18". Empty = any version accepted (dev/CI).
    # Prod sets to the version installed on the server.
    EXPECTED_SF_VERSION: str = ""

    # VAPID keypair for Web Push (Phase 201, PUSH-03, D-03). Empty PUBLIC or
    # PRIVATE key means push is disabled: GET /push/vapid-public-key 404s,
    # POST /push/subscribe 503s, no send is ever attempted. Every dev/test/CI
    # run works with zero setup. Generate a real pair with
    # `uv run python scripts/gen_vapid_keys.py` and paste into
    # /opt/flawchess/.env only — never committed, never auto-generated into
    # the database (that would put the private key in every DB dump).
    # Rotating the key invalidates every existing subscription (D-02) — rotate
    # only on key compromise, and truncate push_subscriptions when you do.
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    VAPID_SUBJECT: str = "push@flawchess.com"

    # Resend transactional email (Phase 207, D-03). Empty string = unconfigured:
    # email_service.is_email_configured() returns False and every send is a
    # no-op, mirroring the VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY "empty = disabled"
    # contract above. Every dev/test/CI run works with zero setup.
    RESEND_API_KEY: str = ""
    MAIL_FROM: str = "noreply@flawchess.com"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()


def assert_secret_key_configured() -> None:
    """Fail closed if a non-development environment still uses the default SECRET_KEY.

    Mirrors the D-22 deploy-blocker pattern in get_insights_agent(): called from the
    app lifespan at startup (NOT at import time) so maintenance scripts and Alembic —
    which import ``settings`` but never sign tokens — are unaffected. A default
    SECRET_KEY in production means every JWT is forgeable, so we abort startup rather
    than serve auth with a publicly-known signing key (code-review 2026-07-02, #1.2).

    Raises:
        RuntimeError: ENVIRONMENT is not "development" and SECRET_KEY is the default.
    """
    if settings.ENVIRONMENT != "development" and settings.SECRET_KEY == DEFAULT_SECRET_KEY:
        raise RuntimeError(
            "SECRET_KEY is still the insecure default in a non-development environment "
            f"(ENVIRONMENT={settings.ENVIRONMENT!r}). Set a strong random SECRET_KEY in "
            ".env before starting the server."
        )


# Maintenance scripts (backfill_eval, reindex_table, gen_benchmarks, …) accept a
# `--db` flag and resolve the connection URL through here, so the DATABASE_URL_*
# settings above are the one place credentials/hosts/ports are configured.
DbTarget = Literal["dev", "test", "prod", "benchmark"]


def db_url_for_target(target: str) -> str:
    """Resolve a script ``--db`` target to its configured async DB URL.

    ``target`` is one of ``DbTarget`` (typed loosely as ``str`` because callers
    pass argparse values). Reads the matching ``DATABASE_URL_*`` setting (sourced
    from ``.env``). Raises ``ValueError`` for an unknown target.
    """
    urls: dict[str, str] = {
        "dev": settings.DATABASE_URL_DEV,
        "test": settings.DATABASE_URL_TEST,
        "prod": settings.DATABASE_URL_PROD,
        "benchmark": settings.DATABASE_URL_BENCHMARK,
    }
    try:
        return urls[target]
    except KeyError:
        raise ValueError(f"Unknown DB target: {target!r}. Must be one of: {sorted(urls)}") from None
