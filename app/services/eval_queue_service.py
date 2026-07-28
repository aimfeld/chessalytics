"""Priority queue service for the full-ply eval drain (QUEUE-01/02/05/06/08).

Tiered pick (tier 2 is fully retired — Phase 118 removed its only enqueue
source, Phase 149-04 removed the then-callerless TIER_2 constant):
  Tier 1 (TIER_EXPLICIT)      — explicit user request
  Tier 3 (TIER_IDLE_BACKLOG)  — idle backlog (derived pick, no eval_jobs row)

Tier-1 uses SELECT FOR UPDATE OF … SKIP LOCKED against the eval_jobs table for
a lock-safe, serialized claim contract (QUEUE-06 / SEED-012 D-8); the claim SQL
is tier-agnostic (`ORDER BY tier ASC`) so it would transparently pick up a
future tier-2 row without any code changes.

Tier-3 is a *derived* pick via a SINGLE Efraimidis–Spirakis recency-weighted
lottery over candidate users. Quick 260723-j6g unified the population: a
candidate user is anyone with EITHER a needs-engine game (full_evals_completed_at
IS NULL AND lichess_evals_at IS NULL, non-guest only) OR a lichess-eval-pv-
incomplete game (full_pv_completed_at IS NULL AND lichess_evals_at IS NOT NULL,
any user incl. guests). No rows are pre-populated in eval_jobs for the backlog.
This keeps the queue table lean (~558k backlog games never pre-inserted) while
providing fast catch-up for returning users (SEED-046).

DELIBERATE PRECEDENCE CHANGE (260723-j6g, supersedes 174-07/SEED-109): prior to
this quick, the lichess-eval population ran ONLY as a residual fallback — it was
drawn only when NO needs-engine candidate existed anywhere. Verified against prod
2026-07-23: user 235's 63.5k-game needs-engine import (~5 days to drain) was
starving user 28's 3 returning lichess-eval games, because the residual lane never
got a turn while ANY needs-engine game existed for ANY user. The τ½=1d
recency-weighted user lottery exists precisely so a returning user wins a fair
share of draws against a mass importer — but the lichess-eval population never
entered that lottery. Folding it into the SAME unified Step-1/Step-2 draw fixes
this: lichess-eval games now compete on equal footing with needs-engine games,
weighted by the same recency lottery, instead of only draining when the
needs-engine backlog is globally empty. There is no more residual fallback lane.

Tier 4b (TIER_BESTMOVE_BACKFILL, Phase 176 BACK-01) is a separate spare-capacity
lottery ordered after tier-4 blob backfill in the bundled scope=None path: it
picks a PV-complete, best-move-incomplete, non-lichess-eval, non-guest game
(the engine-side sibling of the 174-07 residual fallback above) and requires
BOTH EVAL_AUTO_DRAIN_ENABLED and the dedicated BEST_MOVE_BACKFILL_ENABLED gate
(D-05) — best-move backfill is backend-only (Maia inference cannot run on the
remote worker fleet) so it needs an independent kill-switch.

Lease TTL:
  LEASE_TTL_SECONDS = 120
  Derivation: tier-1 fan-out ≈ 10s (all plies via pool, spike-003); tier-2/3
  per-worker worst case ≈ 60 plies × 0.98 s/ply ≈ 59s. 2× the slow case → 120s.

Security (RESEARCH §Security V5):
  All worker_id / TTL / τ / floor values are bound as :params — never interpolated
  into the sa.text CTE string. No f-string is used inside sa.text calls.

QUEUE-08 (guest exclusion):
  Every claim path JOINs the users table and filters NOT users.is_guest.
  enqueue_tier1_game also refuses to enqueue a guest's game (no-op).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

import math

import sqlalchemy as sa
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import async_session_maker
from app.models.eval_jobs import (
    EvalJob,
    TIER_EXPLICIT,
    TIER_IDLE_BACKLOG,
    TIER_BLOB_BACKFILL,
    TIER_BESTMOVE_BACKFILL,
)  # noqa: F401 — re-export constants for callers
from app.models.game import Game
from app.models.user import User

# ─── Module-level constants (no magic numbers) ────────────────────────────────

# 2× the slowest tier-2/3 per-worker game: ~60 plies × 0.98 s/ply ≈ 59s.
# Tier-1 fan-out across the full pool: ~60 plies / 6 workers × 0.98 s ≈ 10s.
# 120s covers both tiers with a comfortable safety margin.
LEASE_TTL_SECONDS: int = 120

# Default worker identity for the server-side engine pool.
# Future browser workers will supply their own identity (SEED-012 D-8).
WORKER_ID_SERVER_POOL: str = "server-pool"

# Status literals (Literal type keeps ty + mypy happy; DB stores varchar(20))
EvalJobStatus = Literal["pending", "leased", "completed", "failed"]

# ─── SEED-046: recency-weighted tier-3 lottery constants ─────────────────────

# Recency half-life for the ES user lottery. τ½ = 1d → a returning user
# (last_activity ≈ now, weight ≈ 1.0) wins ~30–40% of draws even against
# 1–2 currently-recent users; badge ticks roughly every ~25s at the ~10s
# tier-3 claim cadence. PROD TUNING: raise to 2–3d for broader idle sharing at
# the cost of less immediate return-burst responsiveness. (SEED-046 / RESEARCH-NOTES)
RECENCY_HALF_LIFE_DAYS: float = 1.0

# Anti-starvation floor for the ES key weight. The weight formula is
# exp(-Δt/τ) + WEIGHT_FLOOR so weight is always > 0 (guards against div-by-zero
# in -ln(random())/weight). At floor=0.005 with ~59 non-guest users the total
# floor mass ≈ 0.30, so a lone returner keeps ~65–70% share. Keep ≤ 0.01.
# PROD TUNING: do NOT raise above 0.01 — larger floor swamps the recency signal.
# (SEED-046 / RESEARCH-NOTES τ/floor recommendation)
WEIGHT_FLOOR: float = 0.005

# ─── Tier-4 blob-backfill ES lottery constants (replaces Phase 146 D-01 window) ──
# Two-stage lottery mirroring the tier-3 constants above (see _claim_tier4_blob):
# Stage 1 picks a non-guest user weighted by last_activity recency; Stage 2 picks
# that user's NULL-blob analyzed game weighted by full_evals_completed_at recency.
# The floor terms are the anti-starvation fix (SEED-072 fairness): every pending-
# blob user/game combination gets non-zero draw mass, so an old analyzed corpus
# (e.g. user 28's ~5k games) drains instead of only the freshly-analyzed trickle.
# Independently tunable from the tier-3 constants, though currently seeded from
# the same values.

# Tier-4 Stage 1 user-pick recency half-life. Seeded from RECENCY_HALF_LIFE_DAYS.
# PROD TUNING: raise for broader idle sharing across returning users; see the
# tier-3 RECENCY_HALF_LIFE_DAYS comment above for the same tension.
TIER4_USER_RECENCY_HALF_LIFE_DAYS: float = 1.0

# Tier-4 Stage 1 user-pick anti-starvation floor. Seeded from WEIGHT_FLOOR.
# PROD TUNING: do NOT raise above 0.01 — larger floor swamps the recency signal
# (mirrors the tier-3 WEIGHT_FLOOR comment above).
TIER4_USER_WEIGHT_FLOOR: float = 0.005

# Tier-4 Stage 2 game-pick recency half-life. Seeded from GAME_RECENCY_HALF_LIFE_DAYS.
# PROD TUNING: lower for tighter recency preference; raise for broader spread
# across old games (mirrors the tier-3 GAME_RECENCY_HALF_LIFE_DAYS comment above).
TIER4_GAME_RECENCY_HALF_LIFE_DAYS: float = 30.0

# Tier-4 Stage 2 game-pick anti-starvation floor — the core fix this constants
# block exists for: guarantees every pending-blob game across the whole corpus a
# non-zero draw probability instead of the old hard top-50 cutoff (game #51 by
# full_evals_completed_at DESC had probability zero). Seeded from GAME_WEIGHT_FLOOR.
TIER4_GAME_WEIGHT_FLOOR: float = 0.01

# ─── D-7: game-level weighted-random pick constants ───────────────────────────
# Applied in Step 2 and the residual fallback of _claim_tier3_derived (see D-7
# in SEED-048-headless-remote-eval-worker for rationale).

# Per-TC-bucket weight multiplier for game priority. Higher multiplier → game
# appears more often in ES draws. Ordering mirrors the deterministic TC priority
# from QUEUE-02 (classical first, other last) so priority intent is preserved
# while spreading picks across games within the same TC bucket.
GAME_TC_WEIGHTS: dict[str, float] = {
    "classical": 8.0,
    "rapid": 4.0,
    "blitz": 2.0,
    "bullet": 1.0,
    "other": 0.5,  # deprioritized, catches NULL/unknown buckets via ELSE branch
}

# Game-level recency half-life (days). τ½ = 30d → a game played today has
# recency term ≈ 1.0; a game from 6 months ago has ≈ 0.015. Combined with
# GAME_TC_WEIGHTS the most-recent classical game dominates, but older games
# still receive non-zero probability (spread). PROD TUNING: lower to 7–14d for
# tighter recency preference; raise to 90d for broader spread across old games.
GAME_RECENCY_HALF_LIFE_DAYS: float = 30.0

# Anti-starvation floor for the game weight. Ensures every game has a positive
# ES key denominator (guards div-by-zero when exp term → 0 for very old games
# or games with NULL played_at coalesced to epoch-0). Mirrors WEIGHT_FLOOR
# rationale for the user lottery. Keep small to preserve TC + recency signal.
GAME_WEIGHT_FLOOR: float = 0.01


# ─── Return type ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ClaimedJob:
    """Returned by claim_eval_job when a job was successfully claimed.

    job_id is None for tier-3 derived picks (no eval_jobs row exists for the
    backlog; the drain marks full_evals_completed_at directly).

    is_lichess_eval_game is derived from Game.lichess_evals_at IS NOT NULL
    (D-117-07): True means the game already has lichess %evals → preserve them;
    the drain should skip plies with existing evals (D-116-04 repointed by
    D-117-07). This field name makes the lichess-gate explicit and avoids
    confusion with the source-agnostic flaw-coverage property on Game
    (see RESEARCH-NOTES §Opportunistic cleanup).
    """

    game_id: int
    user_id: int
    tier: int
    is_lichess_eval_game: bool
    job_id: int | None  # None for tier-3 derived pick


# ─── Private helpers ─────────────────────────────────────────────────────────


async def _sweep_expired_leases(session: AsyncSession) -> int:
    """Reset expired leased rows to 'pending'.

    Called at the top of each claim to ensure stale leases are cleaned up
    before the SKIP LOCKED pick runs, so they re-enter the queue immediately.

    Returns the number of rows requeued.
    """
    jobs_table = EvalJob.__table__
    now_ts = datetime.now(timezone.utc)
    stmt = (
        update(jobs_table)  # ty: ignore[invalid-argument-type]
        .where(
            jobs_table.c.status == "leased",
            jobs_table.c.lease_expiry < now_ts,
        )
        .values(status="pending", leased_by=None, lease_expiry=None)
    )
    result = await session.execute(stmt)
    return result.rowcount  # ty: ignore[unresolved-attribute]  # SQLAlchemy DML result carries rowcount


async def _claim_queued_job(
    session: AsyncSession,
    worker_id: str,
    lease_ttl_seconds: int,
) -> tuple[int, int, int, int, bool] | None:
    """Claim one pending tier-1 job via SELECT FOR UPDATE OF SKIP LOCKED.

    Returns (job_id, game_id, user_id, tier, is_lichess_eval_game) or None when empty.

    The SKIP LOCKED CTE is the canonical PostgreSQL job-queue primitive (RESEARCH §3).
    All bound values (:worker_id, :ttl) are parameterized — no string interpolation.

    Within a tier:
      - Oldest-pending user first (round-robin approximation via MIN(created_at), QUEUE-02)
      - Within a user: classical > rapid > blitz > bullet > other (D-117-04)
      - Within a TC bucket: most-recent game first (played_at DESC)

    Guest exclusion: JOIN users + NOT is_guest filter (QUEUE-08); guests are
    excluded EXCEPT for their own explicit tier-1 jobs (OR ej.tier = 1).
    """
    result = await session.execute(
        sa.text("""
            WITH candidate AS (
                SELECT ej.id, ej.game_id, ej.user_id, ej.tier
                FROM eval_jobs ej
                JOIN games g ON g.id = ej.game_id
                JOIN users u ON u.id = ej.user_id
                WHERE ej.status = 'pending'
                  AND (u.is_guest = false OR ej.tier = 1)
                ORDER BY
                    ej.tier ASC,
                    (SELECT MIN(j2.created_at) FROM eval_jobs j2
                     WHERE j2.user_id = ej.user_id AND j2.status = 'pending') ASC,
                    CASE g.time_control_bucket
                        WHEN 'classical' THEN 0
                        WHEN 'rapid'     THEN 1
                        WHEN 'blitz'     THEN 2
                        WHEN 'bullet'    THEN 3
                        ELSE 4
                    END ASC,
                    g.played_at DESC NULLS LAST
                LIMIT 1
                FOR UPDATE OF ej SKIP LOCKED
            )
            UPDATE eval_jobs ej
            SET status = 'leased',
                leased_by = :worker_id,
                lease_expiry = now() + (:ttl || ' seconds')::interval
            FROM candidate
            WHERE ej.id = candidate.id
            RETURNING ej.id, ej.game_id, ej.user_id, candidate.tier
        """),
        {"worker_id": worker_id, "ttl": str(lease_ttl_seconds)},
    )
    row = result.one_or_none()
    if row is None:
        return None

    job_id: int = row[0]
    game_id: int = row[1]
    user_id: int = row[2]
    tier: int = row[3]

    # Resolve is_lichess_eval_game (D-117-07): lichess_evals_at IS NOT NULL.
    game_result = await session.execute(select(Game.lichess_evals_at).where(Game.id == game_id))
    lichess_evals_at = game_result.scalar_one_or_none()
    is_lichess_eval_game = lichess_evals_at is not None

    return job_id, game_id, user_id, tier, is_lichess_eval_game


async def _es_weighted_user_pick(
    session: AsyncSession,
    *,
    candidate_exists_sql: str,
    recency_col_sql: str,
    tau_seconds: float,
    floor: float,
    include_guests: bool = False,
) -> int | None:
    """Generic Efraimidis–Spirakis weighted user pick (WRITE-06).

    Shared building block behind both _claim_tier3_derived's Step 1 and
    _claim_tier4_blob's Stage 1 — the acquisition shape (candidate filter +
    recency-weighted ES key) is identical between tiers; only the EXISTS
    predicate narrowing "eligible" candidates and which recency column anchors
    the decay differ per tier.

    weight = exp(-Δt/τ) + floor, where Δt = seconds since recency_col_sql
    (COALESCE'd to epoch-0 so NULL → exp term ≈ 0, weight ≈ floor). Pick
    ORDER BY -ln(random()) / weight LIMIT 1 (the ES key: LIMIT 1 = winner).

    candidate_exists_sql / recency_col_sql are trusted, hardcoded SQL fragments
    authored by the call sites below (never derived from request/user input) —
    composing query SHAPE from these fixed strings carries no injection surface.
    All variable VALUES (tau_seconds, floor) are bound via the sa.text params
    dict — never f-string-interpolated (QUEUE-08).

    include_guests (default False) keeps the QUEUE-08 guest exclusion for the
    tier-3 needs-engine Step-1 and tier-4-blob Stage-1 callers. It is passed
    True ONLY by _claim_tier4_bestmove (Quick 260719-fsz) so guest full_pv-set
    best_moves-NULL games self-heal through the minimal best-move lane; the
    guest clause is composed from fixed in-code literals (no request/user
    input), so toggling it introduces no injection surface.

    Returns the picked user_id, or None when no candidate exists.
    """
    # Fixed-literal composition (no user input) — see include_guests above.
    guest_clause = "" if include_guests else "u.is_guest = false AND"
    result = await session.execute(
        sa.text(f"""
            SELECT u.id
            FROM users u
            WHERE {guest_clause}
              EXISTS (
                {candidate_exists_sql}
              )
            ORDER BY
                -ln(random()) / (
                    exp(
                        -EXTRACT(EPOCH FROM (now() - COALESCE({recency_col_sql}, '1970-01-01'::timestamptz)))
                        / :tau_s
                    ) + :floor
                )
            LIMIT 1
        """),
        {"tau_s": tau_seconds, "floor": floor},
    )
    row = result.one_or_none()
    return row[0] if row is not None else None


async def _es_weighted_game_pick(
    session: AsyncSession,
    *,
    game_where_sql: str,
    recency_col_sql: str,
    tau_seconds: float,
    game_floor: float,
    tc_weights: dict[str, float],
    extra_params: dict[str, Any] | None = None,
) -> int | None:
    """Generic Efraimidis–Spirakis weighted game pick (WRITE-06).

    Shared building block behind _claim_tier3_derived's Step 2 AND residual
    fallback, and _claim_tier4_blob's Stage 2 — all three share the identical
    TC-multiplier CASE block (tc_weights, e.g. GAME_TC_WEIGHTS) and ES key
    shape; only the WHERE predicate and which recency column anchors the
    decay differ per call site.

    game_weight = tc_multiplier * (exp(-Δt/τ) + game_floor), where
    tc_multiplier comes from tc_weights and Δt = seconds since recency_col_sql
    (COALESCE'd to epoch-0). Pick ORDER BY -ln(random()) / game_weight LIMIT 1.

    game_where_sql / recency_col_sql are trusted, hardcoded SQL fragments
    authored by the call sites below (never derived from request/user input);
    game_where_sql may reference bound params (e.g. :picked_user) supplied via
    extra_params. All numeric weight values (and any extra_params) are bound
    via the sa.text params dict — never f-string-interpolated (QUEUE-08).

    Returns the picked game_id, or None when no candidate game matches.
    """
    params: dict[str, Any] = {
        "tc_classical": tc_weights["classical"],
        "tc_rapid": tc_weights["rapid"],
        "tc_blitz": tc_weights["blitz"],
        "tc_bullet": tc_weights["bullet"],
        "tc_other": tc_weights["other"],
        "tau_game": tau_seconds,
        "game_floor": game_floor,
    }
    if extra_params:
        params.update(extra_params)
    result = await session.execute(
        sa.text(f"""
            SELECT g.id
            FROM games g
            WHERE {game_where_sql}
            ORDER BY
                -ln(random()) / (
                    CASE g.time_control_bucket
                        WHEN 'classical' THEN CAST(:tc_classical AS float8)
                        WHEN 'rapid'     THEN CAST(:tc_rapid AS float8)
                        WHEN 'blitz'     THEN CAST(:tc_blitz AS float8)
                        WHEN 'bullet'    THEN CAST(:tc_bullet AS float8)
                        ELSE CAST(:tc_other AS float8)
                    END
                    * (
                        exp(
                            -EXTRACT(EPOCH FROM (now() - COALESCE({recency_col_sql}, '1970-01-01'::timestamptz)))
                            / CAST(:tau_game AS float8)
                        ) + CAST(:game_floor AS float8)
                    )
                )
            LIMIT 1
        """),
        params,
    )
    row = result.one_or_none()
    return row[0] if row is not None else None


async def _claim_tier3_derived(
    session: AsyncSession,
) -> tuple[int, int, bool] | None:
    """Derive a tier-3 pick using ONE unified recency-weighted Efraimidis–Spirakis
    user lottery over the needs-engine ∪ lichess-eval-pv-incomplete population
    (260723-j6g — see the module docstring's DELIBERATE PRECEDENCE CHANGE note).

    Two steps in a single session (no locking — see Phase 118 note below), both
    built on the shared _es_weighted_user_pick / _es_weighted_game_pick building
    blocks (WRITE-06). There is no residual fallback lane — the population that
    used to run there is folded directly into Step 1/Step 2 below.

    Step 1 — UNIFIED WEIGHTED USER PICK (SEED-046, unified 260723-j6g):
      Candidate users = users with at least one game matching EITHER branch of
      the union:
        (a) needs-engine: full_evals_completed_at IS NULL AND lichess_evals_at
            IS NULL, guarded by u.is_guest = false (QUEUE-08 — guests never
            qualify via this branch); backed by the
            ix_games_needs_engine_full_evals partial index (migration 119-01).
        (b) lichess-eval-pv-incomplete: full_pv_completed_at IS NULL AND
            lichess_evals_at IS NOT NULL, unguarded so guests DO qualify via
            this branch (the same guest-eligible lane the old residual fallback
            ran, Quick 260719-fsz); backed by the
            ix_games_lichess_pv_backfill_pending partial index (174-07).
      _es_weighted_user_pick is called with include_guests=True so its own
      outer `u.is_guest = false AND` filter is DROPPED — the per-branch guard
      above is what enforces QUEUE-08 now, expressed inside the EXISTS subquery
      (valid: the subquery is correlated on u.id, so u.is_guest is in scope).
      weight = exp(-Δt/τ) + WEIGHT_FLOOR, where Δt = seconds since last_activity
      (NULL → coalesced to a very old timestamp so the exp term ≈ 0 and weight ≈
      floor), τ = RECENCY_HALF_LIFE_DAYS / ln(2) converted to seconds. weight is
      always > 0 (guards div-by-zero in the ES key).

    Step 2 — UNIFIED WEIGHTED GAME PICK FOR PICKED USER (D-7, unified 260723-j6g):
      Within the chosen user, pick a game via the SAME union predicate as Step 1,
      scoped to g.user_id = :picked_user — game_weight = tc_multiplier *
      (exp(-Δt_played / τ_game) + GAME_WEIGHT_FLOOR). The needs-engine branch is
      guarded by `EXISTS (SELECT 1 FROM users u WHERE u.id = :picked_user AND
      u.is_guest = false)` so a guest's needs-engine game can NEVER be picked
      here even if Step 1 somehow picked a guest (it only can via branch (b));
      the lichess-eval branch is unguarded. tc_multiplier comes from
      GAME_TC_WEIGHTS (classical=8 > rapid=4 > blitz=2 > bullet=1 > other=0.5),
      τ_game derives from GAME_RECENCY_HALF_LIFE_DAYS, and Δt_played is seconds
      since played_at (NULL coalesced to epoch-0). This preserves D-7 (three
      workers landing on the same user usually pick different games; D-4
      residual-duplicate acceptance still stands). Both callers benefit: the
      in-process server pool and the 120-02 HTTP lease endpoint both reach this
      via claim_eval_job / direct call — no caller change needed.

      After Step 2 returns a game_id, is_lichess_eval_game is derived PER-GAME
      via a PK-indexed lookup (`select(Game.lichess_evals_at).where(Game.id ==
      game_id)`) rather than assumed from which branch "should" have matched —
      this is more robust than branch-tagging and matches how the tier-1/2 and
      tier-4b paths already resolve the flag elsewhere in this module.

      If Step 1 returns None (no candidate anywhere) → return None. If Step 2
      returns None (a race: the picked user's matching games drained between
      Step 1 and Step 2) → return None; the next tick re-draws. There is
      deliberately NO fallback lane here — reintroducing one would resurrect
      the precedence bug this quick fixes.

    This replaces the old D-118-04 last_activity DESC winner-take-all ordering and
    drops the dead lichess_evals_at tiebreaker (live prod bug: it was the LAST ORDER
    key and played_at broke ties first, so lichess games were picked at full engine
    cost despite the needs-engine predicate above saying to skip them — ~70%
    throughput waste on user 28; see RESEARCH-NOTES §Live prod bug). It further
    replaces the 174-07/SEED-109 residual-fallback precedence (lichess-eval games
    only drawn when the needs-engine backlog is globally empty) with the unified
    single-lottery precedence described above (260723-j6g).

    Guest asymmetry (QUEUE-08, Quick 260719-fsz) is preserved but now expressed
    per-branch inside the unified predicate rather than via a blanket outer
    filter: guests are eligible ONLY through the lichess-eval branch, never the
    needs-engine branch, in both Step 1 and Step 2.

    Returns (game_id, user_id, is_lichess_eval_game) or None when nothing to process.

    Note: plain SELECT with no locking — two concurrent workers can pick the same game
    (double-claim). Duplicate work is idempotent (ON CONFLICT DO NOTHING for flaws,
    idempotent oracle UPDATE) but wastes engine calls. D-7 only REDUCES collisions;
    the ephemeral TTL-lease escalation (D-4 "later") remains the deferred zero-
    collision endgame. Add FOR UPDATE SKIP LOCKED when multi-worker leasing is added.

    Security: τ_seconds, floor_val, game τ and multipliers, and :picked_user are
    all bound as :params — no f-string-interpolated VALUES anywhere (see
    _es_weighted_user_pick / _es_weighted_game_pick docstrings for the
    query-shape-vs-value distinction). The EXISTS-subquery fragments composed
    here are trusted hardcoded literals, never derived from request/user input.

    Index note (no migration needed): both branches of the unified predicate are
    already backed by existing partial indexes on games(user_id) —
    ix_games_needs_engine_full_evals (needs-engine) and
    ix_games_lichess_pv_backfill_pending (lichess-eval-pv-incomplete, 174-07) —
    so PostgreSQL can BitmapOr the two partials for Step 1's EXISTS predicate.
    """
    # Convert half-life (days) to the decay constant τ in seconds.
    # τ = τ½ / ln2; weight = exp(-Δt_seconds / τ_seconds) + floor
    tau_seconds: float = RECENCY_HALF_LIFE_DAYS / math.log(2) * 86400.0
    floor_val: float = WEIGHT_FLOOR

    # Game-level ES constants (D-7). τ_game converts GAME_RECENCY_HALF_LIFE_DAYS
    # to seconds exactly as the user τ above. All values bound as :params below.
    tau_game_seconds: float = GAME_RECENCY_HALF_LIFE_DAYS / math.log(2) * 86400.0
    game_floor: float = GAME_WEIGHT_FLOOR

    # Step 1: unified ES weighted user pick over the needs-engine ∪ lichess-eval-
    # pv-incomplete union (260723-j6g). include_guests=True drops
    # _es_weighted_user_pick's own outer guest filter — the per-branch guard
    # below (u.is_guest = false on branch (a) only) is what enforces QUEUE-08.
    picked_user_id = await _es_weighted_user_pick(
        session,
        candidate_exists_sql="""
                SELECT 1 FROM games g
                WHERE g.user_id = u.id
                  AND (
                    (u.is_guest = false
                     AND g.full_evals_completed_at IS NULL
                     AND g.lichess_evals_at IS NULL)
                    OR
                    (g.full_pv_completed_at IS NULL
                     AND g.lichess_evals_at IS NOT NULL)
                  )
        """,
        recency_col_sql="u.last_activity",
        tau_seconds=tau_seconds,
        floor=floor_val,
        include_guests=True,
    )
    if picked_user_id is None:
        return None

    # Step 2: unified ES weighted game pick for the picked user, mirroring the
    # SAME union predicate. The needs-engine branch is guarded by an EXISTS
    # check on the picked user's is_guest flag (a guest can only have reached
    # here via branch (b), but this keeps the two branches independently
    # correct rather than relying on that invariant holding).
    game_id = await _es_weighted_game_pick(
        session,
        game_where_sql=(
            "g.user_id = :picked_user"
            " AND ("
            "  (EXISTS (SELECT 1 FROM users u WHERE u.id = :picked_user AND u.is_guest = false)"
            "   AND g.full_evals_completed_at IS NULL"
            "   AND g.lichess_evals_at IS NULL)"
            "  OR"
            "  (g.full_pv_completed_at IS NULL AND g.lichess_evals_at IS NOT NULL)"
            " )"
        ),
        recency_col_sql="g.played_at",
        tau_seconds=tau_game_seconds,
        game_floor=game_floor,
        tc_weights=GAME_TC_WEIGHTS,
        extra_params={"picked_user": picked_user_id},
    )
    if game_id is None:
        # Race: the picked user's matching games drained between Step 1 and
        # Step 2. No fallback lane — the next tick re-draws (260723-j6g).
        return None

    # Derive is_lichess_eval_game PER-GAME (not per-branch) via a trivial
    # PK-indexed lookup, mirroring how the tier-1/2 and tier-4b paths resolve
    # the same flag elsewhere in this module.
    lichess_result = await session.execute(select(Game.lichess_evals_at).where(Game.id == game_id))
    is_lichess_eval_game = lichess_result.scalar_one_or_none() is not None

    return game_id, picked_user_id, is_lichess_eval_game


async def _claim_tier4_blob(
    session: AsyncSession,
) -> tuple[int, int] | None:
    """Tier-4 spare-capacity lottery: pick one analyzed non-guest game with a NULL-blob flaw.

    Two-stage Efraimidis-Spirakis (ES) weighted lottery mirroring _claim_tier3_derived's
    two-step pattern, built on the same shared _es_weighted_user_pick /
    _es_weighted_game_pick building blocks (see their docstrings for the general
    ES-key derivation; WRITE-06). Both stages run sequentially in the same session —
    no asyncio.gather (AsyncSession is not safe for concurrent coroutine use) and no
    locking, mirroring tier-3's plain-SELECT shape.

    Stage 1 — WEIGHTED USER PICK:
      Candidate users = non-guest users with at least one analyzed game
      (full_evals_completed_at IS NOT NULL) that has a NULL-blob flaw
      (game_flaws.allowed_pv_lines IS NULL). weight = exp(-Δt/τ_u) +
      TIER4_USER_WEIGHT_FLOOR, where Δt = seconds since last_activity (NULL
      coalesced to epoch-0 so the exp term ≈ 0, weight ≈ floor) and τ_u =
      TIER4_USER_RECENCY_HALF_LIFE_DAYS / ln(2) in seconds.

    Stage 2 — WEIGHTED GAME PICK FOR THE PICKED USER:
      Within the picked user, pick a NULL-blob-flaw analyzed game weighted by
      full_evals_completed_at recency AND time-control priority (longer TCs first),
      mirroring tier-3's game pick. weight =
      tc_multiplier * (exp(-Δt_evals/τ_g) + TIER4_GAME_WEIGHT_FLOOR), where
      tc_multiplier comes from GAME_TC_WEIGHTS (classical=8 > rapid=4 > blitz=2 >
      bullet=1 > other=0.5), Δt_evals = seconds since full_evals_completed_at (NULL
      cannot occur here — gated by the WHERE clause), τ_g =
      TIER4_GAME_RECENCY_HALF_LIFE_DAYS / ln(2) in seconds.

    This replaces the Phase 146 D-01 top-N recency-window CTE: that mechanism was a
    hard cutoff (game #51 by full_evals_completed_at DESC had probability zero), so an
    old analyzed corpus (e.g. user 28's ~5k games) never drained while a trickle of
    freshly-analyzed games kept refilling the window. The floor terms here give every
    pending-blob game across the whole corpus non-zero draw mass so the whole backlog
    drains, while the recency weighting keeps freshly-analyzed games dominant on most
    draws (SEED-072 fairness fix).

    Returns (game_id, user_id) or None when no backfill-eligible flaw remains (either
    stage returning no row is a None-guard fall-through, mirroring _claim_tier3_derived's
    None-guard shape).

    No eval_jobs row is created — this is a table-less, idempotent-by-construction lottery.
    Once all of a game's flaw blobs (or D-06 sentinels) are written the game stops matching
    the predicate (no flaw with allowed_pv_lines IS NULL) and is never re-selected.

    is_lichess_eval_game is NOT resolved here — it is determined later in the Plan-03 lease
    handler, which has the full game context needed to route the blob write correctly
    (RESEARCH Pitfall 6). This function returns only the (game_id, user_id) pair.

    Security: :tau_u, :floor_u, :picked_user, :tau_g, :floor_g, and the :tc_* TC
    multipliers are all bound via the sa.text params dict — never f-string-interpolated
    (QUEUE-08 convention, mirrors tier-3's rule above).
    """
    # Convert half-lives (days) to decay constants τ in seconds — same conversion
    # used by _claim_tier3_derived above: τ = τ½ / ln2; weight = exp(-Δt/τ) + floor.
    tau_u_seconds: float = TIER4_USER_RECENCY_HALF_LIFE_DAYS / math.log(2) * 86400.0
    floor_u: float = TIER4_USER_WEIGHT_FLOOR
    tau_g_seconds: float = TIER4_GAME_RECENCY_HALF_LIFE_DAYS / math.log(2) * 86400.0
    floor_g: float = TIER4_GAME_WEIGHT_FLOOR

    # Stage 1: ES weighted user pick over users with an eligible NULL-blob analyzed game.
    picked_user_id = await _es_weighted_user_pick(
        session,
        candidate_exists_sql="""
                SELECT 1 FROM games g
                JOIN game_flaws gf ON gf.game_id = g.id
                WHERE g.user_id = u.id
                  AND g.full_evals_completed_at IS NOT NULL
                  AND gf.allowed_pv_lines IS NULL
        """,
        recency_col_sql="u.last_activity",
        tau_seconds=tau_u_seconds,
        floor=floor_u,
    )
    if picked_user_id is None:
        return None

    # Stage 2: ES weighted game pick for the picked user — full_evals_completed_at
    # recency AND TC priority (longer TCs first), mirroring tier-3's game pick.
    game_id = await _es_weighted_game_pick(
        session,
        game_where_sql=(
            "g.user_id = :picked_user"
            " AND g.full_evals_completed_at IS NOT NULL"
            " AND EXISTS ("
            "SELECT 1 FROM game_flaws gf"
            " WHERE gf.game_id = g.id AND gf.allowed_pv_lines IS NULL"
            ")"
        ),
        recency_col_sql="g.full_evals_completed_at",
        tau_seconds=tau_g_seconds,
        game_floor=floor_g,
        tc_weights=GAME_TC_WEIGHTS,
        extra_params={"picked_user": picked_user_id},
    )
    if game_id is None:
        return None

    return game_id, picked_user_id


async def _claim_tier4_bestmove(
    session: AsyncSession,
) -> tuple[int, int] | None:
    """Tier-4b spare-capacity lottery: pick one PV-complete game still missing
    its best-move pass (Phase 176 BACK-01, D-01/D-02/D-03).

    Near-verbatim copy of _claim_tier4_blob's two-stage ES weighted (user ->
    game) lottery, same plain-SELECT/no-lock shape, reusing the same
    TIER4_*_HALF_LIFE_DAYS / TIER4_*_WEIGHT_FLOOR constants and GAME_TC_WEIGHTS
    (no new tunables — Claude's discretion per CONTEXT.md, "reusing tier-4's is
    the likely default").

    Predicate (identical in BOTH the Stage-1 EXISTS-subquery and the Stage-2
    WHERE): full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS
    NULL. Quick 260719-fsz DROPPED the former `lichess_evals_at IS NULL` clause
    so lichess-eval games whose best-move pass never landed (full_pv stamped but
    best_moves NULL — e.g. orphaned during a Maia-down window) self-heal here
    rather than falling in a permanent coverage hole. This does NOT reintroduce
    the D-03 contention with 174-07's residual fallback: the residual takes only
    full_pv_completed_at IS NULL games while this lane takes only
    full_pv_completed_at IS NOT NULL games, so the two lanes stay DISJOINT on
    full_pv_completed_at (a game matches at most one). include_guests=True on the
    Stage-1 user pick lets guest orphans self-heal too (B2); tier-3 needs-engine
    and tier-4-blob keep excluding guests.

    Stage 2's recency anchor is g.full_pv_completed_at (the column this
    predicate gates on — the event that made the game eligible), mirroring
    _claim_tier4_blob's anchor-on-eligibility-column pattern.

    Returns (game_id, user_id) or None when no eligible game remains. Once a
    game's best-move pass stamps best_moves_completed_at (Phase 176 D-01) it
    stops matching this predicate and is never re-selected (self-termination).

    No eval_jobs row is created — table-less, idempotent-by-construction
    lottery, same as _claim_tier4_blob.

    Security: all numeric lottery VALUES (tau, floor, tc weights, :picked_user)
    are bound via the sa.text params dict inside _es_weighted_user_pick /
    _es_weighted_game_pick — never f-string-interpolated (QUEUE-08 convention).
    """
    tau_u_seconds: float = TIER4_USER_RECENCY_HALF_LIFE_DAYS / math.log(2) * 86400.0
    floor_u: float = TIER4_USER_WEIGHT_FLOOR
    tau_g_seconds: float = TIER4_GAME_RECENCY_HALF_LIFE_DAYS / math.log(2) * 86400.0
    floor_g: float = TIER4_GAME_WEIGHT_FLOOR

    # Stage 1: ES weighted user pick over users with an eligible best-move-pending game.
    # include_guests=True so guest orphans (full_pv set, best_moves NULL) self-heal (B2).
    picked_user_id = await _es_weighted_user_pick(
        session,
        candidate_exists_sql="""
                SELECT 1 FROM games g
                WHERE g.user_id = u.id
                  AND g.full_pv_completed_at IS NOT NULL
                  AND g.best_moves_completed_at IS NULL
        """,
        recency_col_sql="u.last_activity",
        tau_seconds=tau_u_seconds,
        floor=floor_u,
        include_guests=True,
    )
    if picked_user_id is None:
        return None

    # Stage 2: ES weighted game pick for the picked user — full_pv_completed_at
    # recency AND TC priority, mirroring tier-4-blob's game pick.
    game_id = await _es_weighted_game_pick(
        session,
        game_where_sql=(
            "g.user_id = :picked_user"
            " AND g.full_pv_completed_at IS NOT NULL"
            " AND g.best_moves_completed_at IS NULL"
        ),
        recency_col_sql="g.full_pv_completed_at",
        tau_seconds=tau_g_seconds,
        game_floor=floor_g,
        tc_weights=GAME_TC_WEIGHTS,
        extra_params={"picked_user": picked_user_id},
    )
    if game_id is None:
        return None

    return game_id, picked_user_id


# ─── Public API ───────────────────────────────────────────────────────────────


async def claim_eval_job(
    worker_id: str = WORKER_ID_SERVER_POOL,
    scope: Literal["explicit", "idle"] | None = None,
) -> ClaimedJob | None:
    """Claim the next eval job — tier-1 > tier-3 > tier-4 (derived).

    Session discipline: opens its own short session, commits, closes.
    The SKIP LOCKED lock is released immediately on commit — never held
    across the engine gather (Pitfall 1 in RESEARCH §Common Pitfalls).

    D-05 scope param (Phase 123 SEED-051):
      None     → bundled tier-1>3>4 behavior (backward-compat for un-updated workers).
      "explicit" → tier-1 only (_claim_queued_job); return None if empty (skip tier-3/4).
      "idle"   → tier-3 only (still gated by EVAL_AUTO_DRAIN_ENABLED).

    Tier-4 (TIER_BLOB_BACKFILL) fires only after tier-1/3 fall through AND only
    under EVAL_AUTO_DRAIN_ENABLED — spare-capacity flaw-blob backfill (Phase 145).

    SEED-072: tier-4 is NOT served through the idle lease scope — it returns None (→ 204)
    once tier-3 is empty, so remote workers fall through to their dedicated rung-4
    `/flaw-blob-lease` (→ `_claim_tier4_blob` → MultiPV-2 continuation → `/flaw-blob-submit`).

    Doc correction (2026-07-28): this paragraph used to justify that gate by claiming the
    `/submit` path "writes no blob" because `_apply_submit` forces `blob_map={}`. That is
    no longer true — Phase 149-03 PRUNE-01 DELETED the Gen-1 `/lease` + `/submit` pair and
    `_apply_submit` outright, and the atomic lane that replaced them DOES write blobs
    inline: the worker submits `body.blob_nodes`, which `_assemble_flaw_blobs_from_submit`
    reassembles into the `blob_map` passed to `apply_full_eval` (app/routers/eval_remote.py).
    So there are three live blob write paths, not one: the atomic submit (bulk of volume),
    `/flaw-blob-submit` (this tier-4 rung), and the in-process drain.

    The gate itself still stands, but for an EFFICIENCY reason rather than a correctness
    one: routing tier-4 through the atomic lane would re-run a full-game MultiPV-1 pass
    just to fill the residual flaw plies the original submit left NULL, whereas
    `/flaw-blob-lease` evaluates only the continuation FENs. The bundled `scope=None` path
    below keeps tier-4 for its sole consumer, the in-process server-pool drain
    (eval_drain.run_one_full_eval_tick), which writes blobs via the MultiPV-2 pass
    (_build_flaw_multipv2_blobs).

    Returns ClaimedJob or None when there is nothing to process.
    """
    # scope="idle" → skip tier-1/2 entirely; go straight to tier-3.
    # Tier-4 is intentionally NOT reached here (SEED-072); an empty tier-3 returns
    # None → 204 so the remote worker drains tier-4 via /flaw-blob-lease instead.
    if scope == "idle":
        if not settings.EVAL_AUTO_DRAIN_ENABLED:
            return None
        async with async_session_maker() as session:
            derived = await _claim_tier3_derived(session)
        if derived is not None:
            game_id_idle, user_id_idle, is_lichess_eval_game_idle = derived
            return ClaimedJob(
                game_id=game_id_idle,
                user_id=user_id_idle,
                tier=TIER_IDLE_BACKLOG,
                is_lichess_eval_game=is_lichess_eval_game_idle,
                job_id=None,
            )
        return None

    async with async_session_maker() as session:
        # Sweep expired leases first so they re-enter the queue.
        await _sweep_expired_leases(session)
        await session.commit()

    # Attempt tier-1 pick in a fresh short transaction.
    async with async_session_maker() as session:
        queued = await _claim_queued_job(session, worker_id, LEASE_TTL_SECONDS)
        await session.commit()

    if queued is not None:
        job_id, game_id, user_id, tier, is_lichess_eval_game = queued
        return ClaimedJob(
            game_id=game_id,
            user_id=user_id,
            tier=tier,
            is_lichess_eval_game=is_lichess_eval_game,
            job_id=job_id,
        )

    # scope="explicit" → tier-1/2 only; do NOT fall through to tier-3/4.
    if scope == "explicit":
        return None

    # scope is None → bundled flow: fall through to tier-3 derived pick (idle backlog),
    # unless automatic eval is disabled via EVAL_AUTO_DRAIN_ENABLED (e.g. dev, to
    # avoid pinning every local core on the hundreds-of-thousands-game backlog).
    # Tier-1 explicit jobs above are never gated; tier-2 has no enqueue source
    # (Phase 118) so only the tier-3/4 idle drain below is gated by this flag.
    if not settings.EVAL_AUTO_DRAIN_ENABLED:
        return None

    async with async_session_maker() as session:
        derived = await _claim_tier3_derived(session)
        # No write needed for tier-3; session auto-closes.

    if derived is not None:
        game_id3, user_id3, is_lichess_eval_game3 = derived
        return ClaimedJob(
            game_id=game_id3,
            user_id=user_id3,
            tier=TIER_IDLE_BACKLOG,
            is_lichess_eval_game=is_lichess_eval_game3,
            job_id=None,  # no eval_jobs row for tier-3
        )

    # Tier-3 empty → fall through to tier-4 blob-backfill spare-capacity lottery.
    # Same EVAL_AUTO_DRAIN_ENABLED gate (already checked above); live tier-1/2/3
    # work always preempts tier-4 (D-02).
    # SEED-072: retained here (unlike the idle scope) because the only bundled-path
    # consumer is the in-process server-pool drain (eval_drain.run_one_full_eval_tick),
    # which writes blobs via the MultiPV-2 pass — not the broken `/submit` path.
    async with async_session_maker() as session:
        blob_pick = await _claim_tier4_blob(session)

    if blob_pick is None:
        # Tier-4 blob empty -> try tier-4b best-move backfill (Phase 176
        # BACK-01, D-02/D-05). EVAL_AUTO_DRAIN_ENABLED is already True at this
        # point (checked above); only the dedicated gate needs checking here,
        # BEFORE the DB round-trip (avoids two wasted queries per idle tick
        # when disabled).
        if not settings.BEST_MOVE_BACKFILL_ENABLED:
            return None
        async with async_session_maker() as session:
            bestmove_pick = await _claim_tier4_bestmove(session)
            if bestmove_pick is None:
                return None
            game_id4b, user_id4b = bestmove_pick
            # Quick 260719-fsz: tier-4b now admits lichess-eval games, so the
            # old "False by construction" is no longer true — resolve the flag
            # from the game row (same PK lookup the tier-1/2 path uses). The
            # minimal drain re-derives this itself, so this field is
            # observability-only here, but a stale False would be a landmine.
            lichess_at_4b = await session.execute(
                select(Game.lichess_evals_at).where(Game.id == game_id4b)
            )
            is_lichess_4b = lichess_at_4b.scalar_one_or_none() is not None
        return ClaimedJob(
            game_id=game_id4b,
            user_id=user_id4b,
            tier=TIER_BESTMOVE_BACKFILL,
            is_lichess_eval_game=is_lichess_4b,
            job_id=None,  # table-less lottery, no eval_jobs row
        )

    game_id4, user_id4 = blob_pick
    return ClaimedJob(
        game_id=game_id4,
        user_id=user_id4,
        tier=TIER_BLOB_BACKFILL,
        is_lichess_eval_game=False,  # resolved in Plan-03 lease handler (Pitfall 6)
        job_id=None,  # table-less lottery, no eval_jobs row (D-03)
    )


async def report_job_complete(job_id: int) -> None:
    """Mark a leased eval_job as completed.

    Short session; idempotent (re-completing an already-completed job is a no-op
    because the WHERE matches only 'leased' rows).
    """
    async with async_session_maker() as session:
        jobs_table = EvalJob.__table__
        now_ts = datetime.now(timezone.utc)
        stmt = (
            update(jobs_table)  # ty: ignore[invalid-argument-type]
            .where(
                jobs_table.c.id == job_id,
                jobs_table.c.status == "leased",
            )
            .values(status="completed", completed_at=now_ts)
        )
        await session.execute(stmt)
        await session.commit()


async def release_job(job_id: int) -> None:
    """Release a single leased eval_job back to 'pending' so it can be re-claimed.

    Used by the remote lease handler (`/atomic-lease`) when it claims a tier-1
    job it cannot hand a real lease payload to — currently only the
    over-cap sentinel path (a lease that would exceed MAX_SUBMIT_EVALS positions,
    147-03/SEED-073). Without this the row would sit 'leased' for the full
    LEASE_TTL_SECONDS before the stale-lease sweep frees it, stalling the very
    click-to-pickup latency Phase 121 improves. (Historical: Phase 121 also used
    this for a lichess-eval-game 204-defer path; that path was retired in Phase
    174-06/SEED-109 — lichess-eval games now lease and submit like any other game.)

    Short session; guarded WHERE status='leased' so it is a no-op if the lease was
    already swept/completed/re-claimed (cannot disturb an unrelated job state).
    """
    async with async_session_maker() as session:
        jobs_table = EvalJob.__table__
        stmt = (
            update(jobs_table)  # ty: ignore[invalid-argument-type]
            .where(
                jobs_table.c.id == job_id,
                jobs_table.c.status == "leased",
            )
            .values(status="pending", leased_by=None, lease_expiry=None)
        )
        await session.execute(stmt)
        await session.commit()


async def requeue_expired_leases() -> int:
    """Reset expired leased rows to 'pending'. Returns count requeued.

    Standalone entry point for external callers (e.g. maintenance scripts).
    The claim_eval_job function also calls this inline at the top of each tick.
    """
    async with async_session_maker() as session:
        count = await _sweep_expired_leases(session)
        await session.commit()
    return count


async def enqueue_tier1_game(game_id: int, user_id: int) -> bool:
    """Insert a tier-1 eval_job for one game. Returns True if a row was inserted.

    Idempotent: ON CONFLICT DO NOTHING on the active-job partial unique index
    (uq_eval_jobs_game_active, status IN ('pending','leased')). A game already
    in any active status is silently skipped.

    Tier-1 is an explicit per-game request that a guest may make for their own
    game (QUEUE-08 guest gate opened for tier-1). Only a missing user row
    (deleted between game load and this call) returns False — no Sentry, not a bug.

    Returns False only when the user row is missing or the game is already queued.
    """
    async with async_session_maker() as session:
        # Look up the user's is_guest flag.
        user_result = await session.execute(select(User.is_guest).where(User.id == user_id))
        is_guest = user_result.scalar_one_or_none()
        # Bug fix: scalar_one_or_none() returns None when the user row is missing
        # (deleted between game load and this lookup). `if is_guest:` evaluates
        # `if None:` → False, letting execution reach the FK insert and raising
        # an unhandled IntegrityError / 500.  Treat missing user as non-enqueue.
        if is_guest is None:
            return False

        stmt = (
            pg_insert(EvalJob)
            .values(
                tier=TIER_EXPLICIT,
                user_id=user_id,
                game_id=game_id,
                status="pending",
            )
            # uq_eval_jobs_game_active is a partial unique index on game_id
            # WHERE status IN ('pending', 'leased'). The index_where must match
            # the partial index predicate so PostgreSQL resolves the conflict target.
            # Completed/failed jobs DO allow re-enqueue (not covered by the partial
            # index). See RESEARCH Pitfall 6 / eval_jobs.py model comments.
            .on_conflict_do_nothing(
                index_elements=["game_id"],
                index_where=sa.text("status IN ('pending', 'leased')"),
            )
        )
        result = await session.execute(stmt)
        await session.commit()

    # rowcount is 1 when a row was inserted, 0 on conflict.
    return (result.rowcount or 0) > 0  # ty: ignore[unresolved-attribute]  # SQLAlchemy DML result carries rowcount
