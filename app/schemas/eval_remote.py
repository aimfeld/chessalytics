"""Pydantic v2 schemas for the eval remote API endpoints (Phase 120 SEED-048)."""

from datetime import datetime

from pydantic import BaseModel, Field

# Upper bound on the submitted evals list. A real game has at most a few hundred
# plies; this cap is generous insurance against a buggy/compromised worker posting
# an arbitrarily large body that the endpoint would materialize in memory at once.
MAX_SUBMIT_EVALS: int = 1024

# Per-field worker-submit bounds (code-review 2026-07-02, #11). An out-of-range value
# from a buggy/compromised worker would otherwise reach the DB and raise a DBAPIError →
# 500 → an unresolvable worker retry-loop that never fills the hole. Reject it at the API
# boundary (422) instead, and cap pv to block multi-MB payloads.
#   - eval_cp / eval_mate: game_positions.eval_cp/eval_mate are SMALLINT columns.
#   - best_move: stored in a String(5) column (UCI, e.g. "e7e8q").
#   - pv: space-joined UCI "up to 12 plies" (~71 chars); 512 leaves generous headroom.
#   - ply: game_positions.ply is SMALLINT with a real-world max of ~600 half-moves.
EVAL_CP_MIN: int = -32768
EVAL_CP_MAX: int = 32767
EVAL_MATE_MIN: int = -32768
EVAL_MATE_MAX: int = 32767
MAX_BEST_MOVE_LEN: int = 5
MAX_PV_LEN: int = 512
MAX_PLY: int = 2048


class LeasePosition(BaseModel):
    ply: int = Field(ge=0)
    fen: str  # board.fen() — full FEN including turn, castling, en passant
    is_terminal: bool  # True for the terminal eval-donor
    # Phase 177 PROTO-01/S-01: the UCI of the move PLAYED from this ply's board (None
    # for the terminal donor, or for a v1 worker's earlier lease response shape — this
    # field is purely additive). The v2 worker compares this against its own MultiPV-1
    # best to find played==best gem candidates without a second server round-trip.
    move_uci: str | None = Field(default=None, max_length=MAX_BEST_MOVE_LEN)


# ─── Phase 123 SEED-051: entry-ply (import-time) batched schemas (D-07) ──────
# Entry-ply is a BATCH across games, so every position carries its game_id.
# Entry-ply uses depth-15 → returns only eval_cp/eval_mate (no best_move/pv).
# Reuses MAX_SUBMIT_EVALS cap (DoS guard — T-123-05): 50 games × ~3 plies ≈ 150 < 1024.


class EntryLeasePosition(BaseModel):
    game_id: int
    ply: int = Field(ge=0)
    fen: str  # board.fen() — full FEN including turn, castling, en passant


class EntryLeaseResponse(BaseModel):
    positions: list[EntryLeasePosition]
    leased_at: datetime


class EntrySubmitEval(BaseModel):
    game_id: int
    ply: int = Field(ge=0, le=MAX_PLY)
    eval_cp: int | None = Field(ge=EVAL_CP_MIN, le=EVAL_CP_MAX)
    eval_mate: int | None = Field(ge=EVAL_MATE_MIN, le=EVAL_MATE_MAX)


class EntrySubmitRequest(BaseModel):
    sf_version: str  # e.g. "Stockfish 18" — for SF-version gate (T-123-07)
    evals: list[EntrySubmitEval] = Field(max_length=MAX_SUBMIT_EVALS)


class EntrySubmitResponse(BaseModel):
    game_ids: list[int]
    stamped_count: int


# ─── Phase 145 SHIP-01: flaw-blob-only lease/submit schemas (D-04) ────────────
#
# These are a DEDICATED, ISOLATED schema set for the flaw-blob backfill endpoint
# (POST /eval/remote/flaw-blob-lease + POST /eval/remote/flaw-blob-submit).
# Per D-04, they MUST NOT reuse or modify the primary lease/submit schemas — that
# ply-keyed path is safety-critical and must remain unchanged. (D-04 was written
# against the Gen-1 LeaseResponse/SubmitRequest + _apply_submit trio, all deleted in
# Phase 149-03 PRUNE-01; the constraint now applies to their atomic-lane successors.)
#
# Token format (D-04a): "{flaw_ply}:{line}:{node_k}"
#   - flaw_ply: int  — the game_flaws.ply value for this flaw
#   - line: str      — "missed" (PV from flaw position) or "allowed" (PV from flaw+1)
#   - node_k: int    — PV walk index (0 = start board, 1 = after first PV move, ...)
# Example: "10:missed:2" → flaw at ply 10, missed line, third node in the PV walk.
# The worker treats the token as opaque (D-04a): it evaluates the leased FEN at
# MultiPV=2 and echoes the token unchanged on submit; no flaw-structure knowledge needed.


class FlawBlobLeasePosition(BaseModel):
    """One FEN position in a flaw-blob lease; token is the server's reassembly key."""

    token: str  # "{flaw_ply}:{line}:{node_k}" — opaque to worker (D-04a)
    fen: str  # board.fen() — full FEN with turn, castling, en passant


class FlawBlobLeaseResponse(BaseModel):
    """Lease response carrying one game's flaw-blob FENs for MultiPV=2 evaluation."""

    game_id: int
    # Bounded by MAX_SUBMIT_EVALS (DoS guard reused — T-145-05 / T-123-05).
    positions: list[FlawBlobLeasePosition] = Field(max_length=MAX_SUBMIT_EVALS)
    leased_at: datetime


class FlawBlobSubmitEval(BaseModel):
    """One worker result: echoed token + MultiPV=2 best and second-best evals."""

    token: str  # echoed from FlawBlobLeasePosition.token unchanged (D-04a)
    best_cp: int | None
    best_mate: int | None
    second_cp: int | None
    second_mate: int | None
    # Wire type is str|None: None = single-legal-move sentinel on the wire.
    # The server maps None → "" when assembling PvNode blobs (Pitfall 3).
    second_uci: str | None


class FlawBlobSubmitRequest(BaseModel):
    """Worker submit payload: game_id, engine version, and per-FEN evaluations."""

    game_id: int
    sf_version: str  # e.g. "Stockfish 18" — for D-5 version gate
    evals: list[FlawBlobSubmitEval] = Field(max_length=MAX_SUBMIT_EVALS)


class FlawBlobSubmitResponse(BaseModel):
    """Submit acknowledgement: how many game_flaws rows had blobs written."""

    game_id: int
    blobs_written: int  # number of flaw rows updated (blobs + sentinels [] counts)


# ─── Phase 147 SEED-074 Part B: atomic lease/submit schema pair (D-02) ────────
#
# NEW, ISOLATED schema set for the versioned lease+submit endpoint pair
# (POST /eval/remote/atomic-lease + POST /eval/remote/atomic-submit). Per D-02
# this is a NEW pair, not an overload of LeaseResponse/SubmitRequest or the
# tier-4 FlawBlob* pair above — the old pair stays deprecated (not removed)
# during a mixed-fleet deploy (old evals-only workers + upgraded evals+blobs
# workers running simultaneously).
#
# The lease payload stays FEN-per-ply (Q4: narrower `_run_all_moves_pass`-based
# worker hint design, RESEARCH.md A2) — no PGN, no Game metadata is added. The
# upgraded worker classifies locally purely as a HINT (which plies are flaws),
# builds its own MultiPV-2 continuation blobs for those plies, and submits
# full-ply evals + blob nodes together. The server re-runs its OWN
# classify_game_flaws authoritatively at submit time — it never trusts the
# worker's local hint-classify as ground truth.


class AtomicLeaseResponse(BaseModel):
    """Lease response for the atomic (versioned) eval+blob worker pipeline."""

    game_id: int
    user_id: int  # informational: the game's authoritative owner (not trusted on submit)
    is_lichess_eval_game: bool
    positions: list[LeasePosition]  # FEN-per-ply — reuses the existing lease position shape
    leased_at: datetime
    # Opaque eval_jobs.id token; None for tier-3 derived picks (no eval_jobs row).
    # The worker echoes this back on submit so the server can stamp eval_jobs.
    job_id: int | None = None


class AtomicSubmitEval(BaseModel):
    """One full-ply engine result (mirrors SubmitEval — MultiPV-1, Phase 146 D-03)."""

    ply: int = Field(ge=0, le=MAX_PLY)
    eval_cp: int | None = Field(ge=EVAL_CP_MIN, le=EVAL_CP_MAX)
    eval_mate: int | None = Field(ge=EVAL_MATE_MIN, le=EVAL_MATE_MAX)
    best_move: str | None = Field(max_length=MAX_BEST_MOVE_LEN)  # UCI string
    pv: str | None = Field(max_length=MAX_PV_LEN)  # space-joined UCI, up to 12 plies


class AtomicBlobNode(BaseModel):
    """One MultiPV-2 continuation-blob node for a flaw ply (mirrors FlawBlobSubmitEval)."""

    token: str  # "{flaw_ply}:{line}:{node_k}" — opaque to worker (D-04a scheme, reused)
    best_cp: int | None
    best_mate: int | None
    second_cp: int | None
    second_mate: int | None
    # Wire type is str|None: None = single-legal-move sentinel on the wire.
    # The server maps None -> "" when assembling PvNode blobs (Pitfall 3).
    second_uci: str | None


# Distinct DoS cap from MAX_SUBMIT_EVALS (D-02) — do NOT reuse or raise the
# shared eval cap for the blob-node list. SEED-073 already documents why
# MAX_SUBMIT_EVALS is a fixed DoS-guard constant, not meant to grow; the same
# reasoning applies here with its own, independently-tunable cap.
MAX_SUBMIT_BLOB_NODES: int = 1024


class AtomicSecondBestEval(BaseModel):
    """One worker-computed MultiPV-2 runner-up eval for a played==best fresh-lane
    ply (Phase 177 PROTO-02/PROTO-03).

    Mirrors AtomicSubmitEval's bounds shape (ply/eval bounds reuse the SAME
    constants — no new numeric literals). The worker submits one of these for
    every out-of-book ply where its own MultiPV-1 best equals the played move;
    the server threads them into `second_best_map` so `_build_best_move_candidates`
    skips its own targeted Stockfish fallback for every covered ply (S-04).
    """

    ply: int = Field(ge=0, le=MAX_PLY)
    second_cp: int | None = Field(ge=EVAL_CP_MIN, le=EVAL_CP_MAX)
    second_mate: int | None = Field(ge=EVAL_MATE_MIN, le=EVAL_MATE_MAX)
    second_uci: str | None = Field(max_length=MAX_BEST_MOVE_LEN)


class AtomicSubmitRequest(BaseModel):
    """Worker submit payload: full-ply evals + MultiPV-2 blob nodes, submitted together."""

    game_id: int
    sf_version: str  # e.g. "Stockfish 18" — for D-5 version gate
    # Q5 (Claude's Discretion, RESEARCH.md): observability/rejection of egregiously
    # stale workers only — correctness is never gated on this field. The server
    # re-classifies authoritatively regardless, and Part A's NULL suppression is
    # the graceful-degradation net under worker/server version skew.
    worker_schema_version: int
    evals: list[AtomicSubmitEval] = Field(max_length=MAX_SUBMIT_EVALS)
    blob_nodes: list[AtomicBlobNode] = Field(max_length=MAX_SUBMIT_BLOB_NODES)
    # Phase 177 PROTO-03: worker-computed gem-candidate runner-up evals for the
    # fresh lane (v2 workers only). A v1 worker that never sends this field
    # validates fine (default empty list) — every played==best candidate then
    # takes the server-side fallback, unchanged from pre-Phase-177 behavior.
    second_best: list[AtomicSecondBestEval] = Field(
        default_factory=list, max_length=MAX_SUBMIT_EVALS
    )
    # Opaque eval_jobs.id token echoed from the lease response; None for tier-3
    # or for a worker that doesn't include the field.
    job_id: int | None = None


class AtomicSubmitResponse(BaseModel):
    """Submit acknowledgement: game id + how many flaw/blob rows were written.

    failed_ply_count / stamp_complete mirror SubmitResponse (CR-01,
    147-REVIEW.md): the atomic-submit write path now shares the same SEED-045
    bounded-retry / hole-detection invariant as /submit, so the worker/operator
    can observe when a submit left holes (stamp_complete=False, Path B) instead
    of that state being silently unobservable.
    """

    game_id: int
    flaws_written: int
    blobs_written: int
    failed_ply_count: int
    stamp_complete: bool


# ─── Phase 177 BACK-02/03: tier-4b dedicated lease/submit schema pair (D-02) ──
#
# NEW, ISOLATED schema set for the tier-4b best-move backfill lease/submit pair
# (POST /eval/remote/bestmove-lease + POST /eval/remote/bestmove-submit), mirroring
# the FlawBlob*-pair's isolation contract above. A tier-4b game already has a
# complete MultiPV=1 full-ply pass (game_positions.best_move/eval_cp/eval_mate) —
# the server reconstructs the candidate-ply set itself (out-of-book, played ==
# stored best_move) and leases the worker ONLY the FENs for those plies. The
# worker runs exactly the N targeted MultiPV=2 runner-up searches (S-05) and
# submits back the second-best evals; no move_uci on the wire (the server already
# validated candidacy — Open Question #3, RESEARCH.md).


class BestMoveLeasePosition(BaseModel):
    """One tier-4b candidate ply's FEN for the worker's runner-up (MultiPV-2) search."""

    ply: int = Field(ge=0, le=MAX_PLY)
    fen: str  # board.fen() — the pre-move position at this ply


class BestMoveLeaseResponse(BaseModel):
    """Lease response carrying one game's server-recomputed candidate-ply FENs."""

    game_id: int
    # Bounded by MAX_SUBMIT_EVALS (DoS guard reused — T-145-05/T-123-05 precedent).
    positions: list[BestMoveLeasePosition] = Field(max_length=MAX_SUBMIT_EVALS)
    leased_at: datetime


class BestMoveSubmitEval(BaseModel):
    """One worker-computed MultiPV-2 eval for a candidate ply.

    best_cp/best_mate (Quick 260719-fsz) carry the worker's FRESH Stockfish best
    line (MultiPV-2 line 1). They are OPTIONAL for backward compatibility: a
    pre-260719-fsz worker omits them, so the server falls back to a re-search for
    lichess games (see _apply_bestmove_submit). Once all workers submit them the
    server never re-searches. Engine games ignore them (their stored eval already
    IS our Stockfish).
    """

    ply: int = Field(ge=0, le=MAX_PLY)
    second_cp: int | None = Field(ge=EVAL_CP_MIN, le=EVAL_CP_MAX)
    second_mate: int | None = Field(ge=EVAL_MATE_MIN, le=EVAL_MATE_MAX)
    second_uci: str | None = Field(max_length=MAX_BEST_MOVE_LEN)
    best_cp: int | None = Field(default=None, ge=EVAL_CP_MIN, le=EVAL_CP_MAX)
    best_mate: int | None = Field(default=None, ge=EVAL_MATE_MIN, le=EVAL_MATE_MAX)


class BestMoveSubmitRequest(BaseModel):
    """Worker submit payload: game id, engine version, and per-candidate runner-up evals."""

    game_id: int
    sf_version: str  # e.g. "Stockfish 18" — for the D-5 version gate
    evals: list[BestMoveSubmitEval] = Field(max_length=MAX_SUBMIT_EVALS)


class BestMoveSubmitResponse(BaseModel):
    """Submit acknowledgement: how many game_best_moves rows were written."""

    game_id: int
    rows_written: int
