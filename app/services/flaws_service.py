"""Flaw-detection + classification service for Phase 105 (SEED-036).

Derives per-ply flaw severity and attribution tags from stored Stockfish evals.
No I/O, no DB — the module is a pure Python transform over already-loaded ORM objects.
See tests/services/test_flaws_service.py for unit tests.

Two output types:
  list[FlawRecord]   analyzed game — one entry per user mistake or blunder
  GameNotAnalyzed    chess.com / unanalyzed lichess game (< 90% eval coverage)

Note: inaccuracies are detected internally (for counts and the oracle test) but are
NOT emitted as FlawRecord items. Only mistakes and blunders appear in the returned
list. An inaccuracy-only analyzed game returns an empty list — distinct from
GameNotAnalyzed. See the 2026-06-05 amendment in 105-01-PLAN.md.
"""

from __future__ import annotations

import io
from collections.abc import Mapping
from typing import Literal, TypedDict

import chess
import chess.pgn
import sentry_sdk

from app.models.game import Game
from app.models.game_position import GamePosition
from app.services.eval_utils import eval_cp_to_expected_score
from app.services.forcing_line_gate import (
    ONLY_MOVE_WIN_PROB_MARGIN,
    PvNode,
    apply_forcing_line_filter,
)
from app.services.normalization import parse_base_and_increment
from app.services.openings_service import derive_user_result
from app.services.tactic_detector import detect_tactic_motif

# ---------------------------------------------------------------------------
# Named constants — no magic numbers (CLAUDE.md)
# ---------------------------------------------------------------------------

# Lichess-aligned severity thresholds on the [0,1] ES scale.
# Lichess uses [−1, +1] winningChances with cutoffs 0.10/0.20/0.30; our scale
# is (winningChances + 1) / 2, so thresholds halve. See CONTEXT.md §Severity.
INACCURACY_DROP: float = 0.05
MISTAKE_DROP: float = 0.10
BLUNDER_DROP: float = 0.15

# Mate Option B: map mate eval to ±1000 cp before the sigmoid (CONTEXT.md §Mate).
# Do NOT use eval_mate_to_expected_score (hard 1.0/0.0) for drop math — that
# function is for endgame span averaging and would mis-size mate transitions.
# Since the mate-ladder addition (2026-06-11) Option B only supplies the
# es_before/es_after payload values (impact tags, eval charts); SEVERITY on
# mate-involved transitions comes from _classify_mate_ladder instead.
MATE_CP_EQUIVALENT: int = 1000

# Lichess mate-ladder thresholds (lila modules/tree/src/main/Advice.scala,
# MateAdvice). Severity of a mate transition is graded by the cp eval on the
# non-mate side of the transition, mover-POV:
#   MateCreated (cp -> mate against mover): blunder, downgraded to mistake when
#     the mover was already heavily lost (prev cp < -700) and to inaccuracy when
#     the game was already decided (prev cp < -999).
#   MateLost (mover's forced mate -> cp, or -> mate against mover): blunder,
#     downgraded to mistake when still winning big (next cp > 700) and to
#     inaccuracy when still completely winning (next cp > 999); a mate that
#     flips to a mate AGAINST the mover has no cp side (treated as 0 -> blunder).
# The benchmark-DB sanity check (reports/misc/flaw-count-sanity-lichess-vs-
# game_flaws-2026-06-11.md) showed Option-B-only severity reproduces lichess
# exactly in mate-free games (100.2%) but misses ~12-25% of flaws in mate games:
# flattening every mate to ES 0.9755 makes "threw away a forced mate back to
# +5" a sub-threshold ~0.09 drop that lichess scores as a blunder.
MATE_LADDER_DECIDED_CP: int = 999  # |cp| beyond this: game already decided -> inaccuracy
MATE_LADDER_LOPSIDED_CP: int = 700  # |cp| beyond this: heavily lopsided -> mistake

# Eval coverage gate: fraction of MOVABLE plies with non-null eval required for
# "analyzed". The terminal position (after the last move) always has null eval
# (zobrist.py: no move annotated), so it is excluded from the denominator. A fully-
# analyzed N-ply game thus scores N/N = 100% regardless of length — short games are
# no longer penalized (see _compute_eval_coverage for the bug this corrected).
EVAL_COVERAGE_MIN: float = 0.90

# Impact ladder thresholds (flaw-tag-definitions.md §Impact).
# Outcome-independent: computed from es_before/es_after only, never the game result.
# Recalibrated 2026-06-09 to round-eval anchors (sigmoid of ±1.0/±2.0/+3.0).
FROM_WINNING_ES: float = 0.7511  # squandered entry (>= 75%: winning, near-decisive, ≈ +3.0)
WINNING_LINE_ES: float = 0.6762  # reversed entry (>= 68%: clearly winning, ≈ +2.0)
LOSING_LINE_ES: float = 0.3238  # reversed exit (<= 32%: clearly losing, ≈ −2.0)
SQUANDERED_EXIT_ES: float = 0.5910  # squandered exit (<= 59%: back to a slight edge, ≈ +1.0)

# Tempo thresholds — relative to base_time_seconds (RESEARCH §Pattern 6).
# [ASSUMED] initial values; tunable once real data is available.
TIME_PRESSURE_CLOCK_FRACTION: float = 0.05  # < 5% of base = low clock
HASTY_MOVE_FRACTION: float = 0.01  # < 1% of base = fast move on comfortable clock
TIME_PRESSURE_CLOCK_ABS_SECONDS: float = 30.0  # fallback when base_time unknown
HASTY_MOVE_ABS_SECONDS: float = 5.0  # fallback when base_time unknown

# Oracle closeness tolerance for sanity test against Lichess game-level columns.
# [ASSUMED] — allows ≤2 off per color per severity (mate-handling divergence).
SANITY_TOLERANCE: int = 2

# ---------------------------------------------------------------------------
# Literal type aliases (CLAUDE.md §Type safety: Literal for fixed-value fields)
# ---------------------------------------------------------------------------

FlawSeverity = Literal["inaccuracy", "mistake", "blunder"]
FlawTag = Literal[
    "miss",
    "lucky",
    "reversed",
    "squandered",
    "low-clock",
    "hasty",
    "unrushed",
    "opening",
    "middlegame",
    "endgame",
]
TempoTag = Literal["low-clock", "hasty", "unrushed"]

# ---------------------------------------------------------------------------
# TypedDict output contract (CONTEXT.md §Output contract; zobrist.py PlyData style)
# ---------------------------------------------------------------------------


class FlawRecord(TypedDict):
    ply: int  # half-move number (0-indexed)
    fen: str  # board_fen() of the position BEFORE the flawed move (piece placement
    # only) — so the Flaws-tab miniboard renders the decision point and move_san
    # resolves to its from/to arrow squares. Since Phase 148 D-02 fen_map holds the
    # FULL board.fen(); this piece-placement-only value is derived by splitting it in
    # _build_flaw_record (fen_before_flaw.split(" ")[0]) — it is NOT filled directly
    # from fen_map.
    side: Literal["white", "black"]  # mover who made the flawed move
    severity: FlawSeverity
    tags: list[FlawTag]  # ordered, additive, orthogonal (populated in plan 02)
    es_before: float  # mover-POV ES before the flaw
    es_after: float  # mover-POV ES after the flaw
    move_san: str | None  # SAN from positions[N].move_san
    # Tactic family — two orientation sets, all optional (Phase 124/128 — D-01).
    #
    # allowed_* — the refutation from the flaw_ply+1 PV (punishing the flaw-maker).
    #   allowed_tactic_motif_int: TacticMotifInt value; None = no detector fired.
    #   allowed_tactic_piece: python-chess PieceType (1-6) per D-12 semantics; None = ambiguous.
    #   allowed_tactic_confidence: winner-confidence 0-100; None when motif is None.
    #   allowed_tactic_depth: loop index within the flaw_ply+1 PV when motif fires (Phase 127 D-04);
    #                         None when motif is None.
    allowed_tactic_motif_int: int | None
    allowed_tactic_piece: int | None
    allowed_tactic_confidence: int | None
    allowed_tactic_depth: int | None
    #
    # missed_* — the "instead-of" tag from the flaw_ply PV (best move the flaw-maker missed).
    #   missed_tactic_motif_int: TacticMotifInt value; None = no detector fired or no flaw_ply PV.
    #   missed_tactic_piece: python-chess PieceType (1-6); None = ambiguous or no motif.
    #   missed_tactic_confidence: winner-confidence 0-100; None when motif is None.
    #   missed_tactic_depth: loop index within the flaw_ply PV when motif fires (Phase 128 D-05);
    #                        None when motif is None. One ply earlier than allowed_tactic_depth's PV.
    #   All four are None until the Phase 128 missed-pass detector runs (Plan 02).
    missed_tactic_motif_int: int | None
    missed_tactic_piece: int | None
    missed_tactic_confidence: int | None
    missed_tactic_depth: int | None


class GameNotAnalyzed(TypedDict):
    reason: Literal["no_engine_analysis"]
    eval_coverage: float  # fraction 0.0–1.0


class SeverityCounts(TypedDict):
    """Per-game severity counts over the USER's moves (Phase 106, LIBG-08).

    Unlike the FlawRecord list (mistakes + blunders only), this carries all
    three tiers including the inaccuracy count — which is never exposed via
    classify_game_flaws (the kernel emits M+B only). See RESEARCH Pitfall 3:
    the I count must NOT be derived from the M+B FlawRecord set.
    """

    inaccuracy: int
    mistake: int
    blunder: int


GameFlawsResult = list[FlawRecord] | GameNotAnalyzed

# Internal type for the all-moves classification pass result per ply
_MoveEntry = tuple[Literal["white", "black"], FlawSeverity | None, float, float]

# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _ply_to_es(
    pos: GamePosition,
    mover_color: Literal["white", "black"],
) -> float | None:
    """Return mover-POV ES for this ply, or None if eval unavailable.

    Option B mate: maps mate to ±MATE_CP_EQUIVALENT cp before sigmoid.
    Do NOT call eval_mate_to_expected_score here — that returns hard 1.0/0.0
    and was built for endgame span averaging, not per-ply drop math (Pitfall 3
    in RESEARCH: mis-sizes mate transitions, would always flag mate-adjacent
    moves as blunders).
    """
    if pos.eval_mate is not None:
        cp_equiv = MATE_CP_EQUIVALENT if pos.eval_mate > 0 else -MATE_CP_EQUIVALENT
        return eval_cp_to_expected_score(cp_equiv, mover_color)
    if pos.eval_cp is not None:
        return eval_cp_to_expected_score(pos.eval_cp, mover_color)
    return None


def _pov_mate(pos: GamePosition, mover_color: Literal["white", "black"]) -> int | None:
    """Mover-POV signed mate distance for this ply, or None if no mate eval."""
    if pos.eval_mate is None:
        return None
    return pos.eval_mate if mover_color == "white" else -pos.eval_mate


def _pov_cp_or_zero(pos: GamePosition, mover_color: Literal["white", "black"]) -> int:
    """Mover-POV cp eval, defaulting to 0 when absent (lila's `cp.so(_.centipawns)`).

    The 0 default only matters on the mate side of a MateLost mate->mate flip,
    where lila grades severity from a cp that doesn't exist: 0 -> blunder.
    """
    if pos.eval_cp is None:
        return 0
    return pos.eval_cp if mover_color == "white" else -pos.eval_cp


def _classify_mate_ladder(
    prev: GamePosition,
    cur: GamePosition,
    mover_color: Literal["white", "black"],
) -> FlawSeverity | None:
    """Lichess MateAdvice severity for a transition involving a mate eval.

    Port of lila modules/tree Advice.scala (MateSequence + MateAdvice), mover-POV:

      MateCreated  prev is cp, cur is mate AGAINST the mover.
      MateLost     prev is the mover's forced mate, cur is cp or mate against.

    Everything else returns None — matching lila, where a mate-involved
    transition can never produce CpAdvice (the mate side has no cp), so e.g.
    mate-in-3 -> mate-in-8 (MateDelayed), escaping a mate-against, or walking
    deeper into one are never the mover's flaw.

    Must only be called when at least one endpoint has eval_mate set; the caller
    guarantees both endpoints carry SOME eval (Option B ES is non-None).
    """
    prev_mate = _pov_mate(prev, mover_color)
    cur_mate = _pov_mate(cur, mover_color)

    # MateCreated: had a cp position, now facing a forced mate.
    if prev_mate is None and cur_mate is not None and cur_mate < 0:
        prev_cp = _pov_cp_or_zero(prev, mover_color)
        if prev_cp < -MATE_LADDER_DECIDED_CP:
            return "inaccuracy"
        if prev_cp < -MATE_LADDER_LOPSIDED_CP:
            return "mistake"
        return "blunder"

    # MateLost: had a forced mate, now a cp position or a mate against the mover.
    if prev_mate is not None and prev_mate > 0 and (cur_mate is None or cur_mate < 0):
        cur_cp = _pov_cp_or_zero(cur, mover_color)
        if cur_cp > MATE_LADDER_DECIDED_CP:
            return "inaccuracy"
        if cur_cp > MATE_LADDER_LOPSIDED_CP:
            return "mistake"
        return "blunder"

    return None


def classify_severity(drop: float) -> FlawSeverity | None:
    """Map a mover-POV ES drop to a severity label, or None if below threshold.

    Highest band wins (CONTEXT.md §Severity). All thresholds are boundary-inclusive.

    Public since Phase 211 (previously a private helper): `train_pool`'s
    vetted-move certification consumes this same ladder — one severity
    ladder server-side, never a second local band (the client twin is
    `frontend/src/lib/liveFlaw.ts`'s `classifyLiveSeverity`, CI-drift-checked
    via the generated thresholds file).
    """
    if drop >= BLUNDER_DROP:
        return "blunder"
    if drop >= MISTAKE_DROP:
        return "mistake"
    if drop >= INACCURACY_DROP:
        return "inaccuracy"
    return None


def _compute_eval_coverage(positions: list[GamePosition]) -> float:
    """Fraction of MOVABLE positions with non-null eval_cp or eval_mate (0.0–1.0).

    The denominator excludes the single structurally-unevaluable terminal position
    (the board after the last move): it never carries an eval because no move is
    annotated from it (zobrist.py). For an N-ply game there are N+1 positions and at
    most N can carry an eval, so a fully-analyzed game scores N/N = 1.0 at any length.

    BUG FIX (quick-task 260615-rb1): the denominator was previously len(positions),
    which counted the unevaluable terminal position against coverage. A fully-analyzed
    7-ply game (8 positions) capped at 7/8 = 0.875 < EVAL_COVERAGE_MIN (0.90), so short
    games were misclassified as GameNotAnalyzed, the oracle (move-quality) columns were
    never written, and the frontend "Analyze" pill never resolved. Dividing by the
    movable-position count (len(positions) - 1) fixes this without over-correcting:
    genuinely sparse games still fall below the threshold.
    """
    # A list with <= 1 position has no movable position (no move was played), so
    # coverage is undefined; return 0.0 (also guards the denominator against zero).
    if len(positions) <= 1:
        return 0.0
    n_with_eval = sum(1 for p in positions if p.eval_cp is not None or p.eval_mate is not None)
    return n_with_eval / (len(positions) - 1)


def _recompute_fen_map(pgn: str) -> dict[int, str]:
    """Return {ply: board.fen()} for every ply by replaying the PGN with python-chess.

    BUGFIX (Phase 148, D-02): this map used to store board_fen() (piece placement
    only), which drops side-to-move, castling rights, and the en-passant target.
    A PV replay through _detect_tactic_for_flaw would then rebuild a chess.Board
    from that incomplete string, silently corrupting castling/en-passant flaw
    positions (parse_san failures, or replaying an en-passant capture against a
    board that never recorded the ep target square).
    This is the ONE sanctioned exception to the CLAUDE.md board_fen()-only rule:
    the map is detector-internal (PV replay / parse_san only) and never touches
    Zobrist position-comparison call sites, which must keep using board_fen().
    Returns empty dict on parse failure, or a partial map if replay fails
    mid-game (callers fall back to fen="" per ply).
    """
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return {}
    board = game.board()
    fens: dict[int, str] = {0: board.fen()}
    try:
        for ply, node in enumerate(game.mainline(), start=1):
            board.push(node.move)
            fens[ply] = board.fen()
    except (ValueError, AssertionError) as exc:
        # WR-03 fix: this PGN already parsed cleanly at import time (its positions
        # and evals are stored), so a replay failure here is a genuine data
        # inconsistency, not expected user-input noise. Capture it — otherwise
        # every later flaw silently falls back to fen="" via fen_map.get(n, "").
        sentry_sdk.set_context("flaws", {"stage": "fen_recompute", "failed_at_ply": len(fens)})
        sentry_sdk.capture_exception(exc)
    return fens


def _run_all_moves_pass(
    positions: list[GamePosition],
) -> dict[int, _MoveEntry]:
    """Classify every ply for both colors — required for miss/unpunished tag adjacency checks.

    Returns {ply_N: (mover_color, severity|None, es_before, es_after)} for
    N in range(1, len(positions)). Plies where either ES is None (interior null
    eval — Pitfall 4) are skipped and not included in the dict.

    ES semantics (eval-AFTER landmine, Pitfall 1):
        positions[N].eval_cp = eval AFTER move N was played.
        ES_before = _ply_to_es(positions[N-1], mover)  # board before mover plays move N
        ES_after  = _ply_to_es(positions[N],   mover)  # board after mover plays move N

    This post-move convention is now uniform across ALL sources (SEED-044): lichess
    `%eval` rows always stored it this way (zobrist.py), and the engine full-eval
    drain now stores it too (eval_drain._post_move_eval). Previously the engine
    drain stored the PRE-PUSH eval (eval BEFORE the move), making this classifier
    off-by-one for every chess.com game — a single real blunder surfaced as a
    spurious adjacent pair or as nothing. No per-source branch is needed here.

    Severity routing mirrors lila's Advice dispatch: cp->cp transitions use the
    ES-drop thresholds (CpAdvice); any transition touching a mate eval uses the
    mate ladder (MateAdvice) — under Option B both endpoints of a mate stretch
    flatten to ~0.9755, so the drop math is blind there (it under-counted thrown
    mates by ~12-25% vs lichess; see MATE_LADDER_* constants). The Option B ES
    values are still recorded for the payload (impact tags, eval charts).
    """
    all_moves: dict[int, _MoveEntry] = {}
    for n in range(1, len(positions)):
        mover: Literal["white", "black"] = "white" if n % 2 == 0 else "black"
        es_before = _ply_to_es(positions[n - 1], mover)
        es_after = _ply_to_es(positions[n], mover)
        if es_before is None or es_after is None:
            # Skip plies with missing eval (Pitfall 4: interior null)
            continue
        if positions[n - 1].eval_mate is not None or positions[n].eval_mate is not None:
            severity = _classify_mate_ladder(positions[n - 1], positions[n], mover)
        else:
            severity = classify_severity(es_before - es_after)
        all_moves[n] = (mover, severity, es_before, es_after)
    return all_moves


def _same_dest_as_best_line(board_before: chess.Board, flaw_san: str, pv: str) -> bool:
    """True if the flaw move and best PV first move share the same destination square.

    Wrong-recapture false-alarm guard (D-03 / Workstream B): when the player captured
    the same piece the best line would capture — just with the wrong piece type — they
    demonstrably SAW the target.  The missed-tactic tag must be suppressed in that case.

    Dest-square equality is the only criterion (D-03 deferred: adding a captured-piece-
    value check only if a unit fixture surfaces a false suppression).

    Returns False on any parse error so the caller falls through to normal detection
    (consistent with the existing guard posture, Security Domain V5).
    """
    try:
        flaw_move = board_before.parse_san(flaw_san)
        pv_moves = pv.split()
        if not pv_moves:
            return False
        best_first_move = chess.Move.from_uci(pv_moves[0])
        return flaw_move.to_square == best_first_move.to_square
    except ValueError, chess.IllegalMoveError:
        return False  # malformed SAN or UCI → fall through to normal detection


def _detect_tactic_for_flaw(
    n: int,
    fen_map: dict[int, str],
    positions: list[GamePosition],
    pv_by_ply: Mapping[int, str] | None = None,
    orientation: Literal["allowed", "missed"] = "allowed",
) -> tuple[int | None, int | None, int | None, int | None]:
    """Detect tactic motif for the flaw at ply N.

    Returns (tactic_motif_int, tactic_piece, tactic_confidence, tactic_depth).
    All four are None when pv is absent, fen is missing, or (allowed only) SAN
    is malformed.

    orientation='allowed' (default):
        Detects the tactic the opponent exploits in the refutation of the flaw.
        PV source: pv_by_ply.get(n + 1) (live drain) or positions[n + 1].pv
        (backfill). Board: board_after_flaw (flaw move pushed). pov = refuting
        side (board_after_flaw.turn).

    orientation='missed':
        Detects the tactic the mover could have used but missed (the "instead-of"
        line). PV source: pv_by_ply.get(n) (live drain) or positions[n].pv
        (backfill). Board: board_before (no flaw move pushed). pov = board_before.turn
        = the mover (D-03, D-06).

    PV source rationale (260618-aiq): the in-process eval drain has just-computed PVs
    in memory that are NOT yet written to game_positions at classify time, so it passes
    them via `pv_by_ply` (ply -> pv_string). The backfill path passes pv_by_ply=None
    and falls back to the persisted pv column, preserving the original behavior exactly.

    Guards implemented:
    - Pitfall 1: `n + 1 < len(positions)` before indexing positions[n+1].pv (allowed)
    - Pitfall 1b: `0 <= n < len(positions)` before indexing positions[n].pv (missed)
    - Pitfall 6: try/except (ValueError, chess.IllegalMoveError) for SAN parse (allowed)
    - T-128-03: missed pass reuses the existing try/except guard in detect_tactic_motif
      (malformed PV never raises out of the detector)
    """
    fen_before_flaw = fen_map.get(n, "")
    if not fen_before_flaw:
        return None, None, None, None

    # fen_map now stores the full board.fen() (Phase 148 D-02), which already
    # carries the correct side-to-move parsed from the FEN string itself. This
    # explicit override is redundant (re-asserts the same value chess.Board
    # already parsed) but harmless, and is kept as a defense-in-depth guard
    # against a partial/legacy fen_map entry — not required for correctness.
    board_before = chess.Board(fen_before_flaw)
    board_before.turn = chess.WHITE if n % 2 == 0 else chess.BLACK

    if orientation == "missed":
        # Missed pass: board_before + flaw_ply PV; pov = the mover (board_before.turn).
        # No flaw move is pushed — the mover is evaluated on the decision position (D-03).
        pv: str | None = None
        if pv_by_ply is not None:
            pv = pv_by_ply.get(n)
        if pv is None and 0 <= n < len(positions):
            pv = positions[n].pv
        if not pv:
            return None, None, None, None
        # D-03 / Workstream B dest-square gate: suppress when the flaw move and the best
        # line's first move share the same destination.  This kills the wrong-recapture
        # false alarm — the player captured the SAME piece with the wrong piece type, so
        # they plainly SAW it; tagging it as "you missed a tactic" is misleading.
        # Bug-fix: false "missed tactic" chips dominated by fork/pin/discovered-attack/
        # skewer (thousands of rows) where the player simply recaptured with the wrong
        # piece.  Guard is in _same_dest_as_best_line; parse errors fall through.
        flaw_san_missed = positions[n].move_san if 0 <= n < len(positions) else None
        if flaw_san_missed and _same_dest_as_best_line(board_before, flaw_san_missed, pv):
            return None, None, None, None
        # D-06: pov at flaw_ply is the mover (board_before.turn). A forced mate FOR the
        # mover means the mover-POV mate distance is positive — allow the mate branch even
        # when the PV is truncated.
        # Bug fix (Phase 148 code review CR-01): GamePosition.eval_mate is stored
        # white-perspective-absolute (positive = white mates), so a raw `> 0` test is only
        # correct when the mover is White. For black-POV flaws (~half of all plies) it
        # inverted the sign and silently dropped real Black forced mates. Convert to the
        # mover's POV via _pov_mate/_solver_color_for before comparing, exactly like every
        # other mate-sign site in this file.
        _pos_missed = positions[n] if 0 <= n < len(positions) else None
        _pov_mate_missed = (
            _pov_mate(_pos_missed, _solver_color_for(n, "missed")) if _pos_missed else None
        )
        has_forced_mate_missed = _pov_mate_missed is not None and _pov_mate_missed > 0
        return detect_tactic_motif(board_before, pv, has_forced_mate=has_forced_mate_missed)

    # orientation == "allowed" (default):
    # Allowed pass: board_after_flaw + refutation PV (flaw_ply+1); pov = refuting side.
    pv_allowed: str | None = None
    if pv_by_ply is not None:
        pv_allowed = pv_by_ply.get(n + 1)
    if pv_allowed is None and n + 1 < len(positions):
        pv_allowed = positions[n + 1].pv
    move_san_of_flaw: str | None = positions[n].move_san

    if not (pv_allowed and move_san_of_flaw):
        return None, None, None, None

    try:
        flaw_move = board_before.parse_san(move_san_of_flaw)
        board_after_flaw = board_before.copy()
        board_after_flaw.push(flaw_move)
        # D-06: pov at flaw_ply+1 is the refuting side (board_after_flaw.turn). The
        # refuting side has a forced mate when its mover-POV mate distance is positive.
        # Bug fix (Phase 148 code review CR-01): eval_mate is white-perspective-absolute,
        # so a raw `> 0` test only holds when the refuter is White; convert to the
        # refuter's POV (== _solver_color_for(n, "allowed") == board_after_flaw.turn)
        # before comparing.
        _pos_allowed = positions[n + 1] if n + 1 < len(positions) else None
        _pov_mate_allowed = (
            _pov_mate(_pos_allowed, _solver_color_for(n, "allowed")) if _pos_allowed else None
        )
        has_forced_mate_allowed = _pov_mate_allowed is not None and _pov_mate_allowed > 0
        return detect_tactic_motif(
            board_after_flaw, pv_allowed, has_forced_mate=has_forced_mate_allowed
        )
    except ValueError, chess.IllegalMoveError:
        # Malformed move_san or FEN — leave all four as None (Pitfall 6)
        return None, None, None, None


def _solver_color_for(
    n: int,
    orientation: Literal["allowed", "missed"],
) -> Literal["white", "black"]:
    """Return the tactic-delivering side's color for the gate (D-02, SC4).

    Even ply means white moved (made the flaw). Ply parity matches the
    board_before.turn convention at flaws_service.py line 444-446.

    "allowed": the refuter (solver) is the OPPONENT of the mover.
    "missed": the flaw-maker (solver) IS the mover.
    """
    if orientation == "allowed":
        return "black" if n % 2 == 0 else "white"
    return "white" if n % 2 == 0 else "black"


def _classify_tactic_gated(
    n: int,
    fen_map: dict[int, str],
    positions: list[GamePosition],
    orientation: Literal["allowed", "missed"],
    pv_blob: list[PvNode] | None,
    pre_flaw_eval_cp: int | None,
    pv_by_ply: Mapping[int, str] | None = None,
    margin: float = ONLY_MOVE_WIN_PROB_MARGIN,
    blobs_pending: bool = False,
) -> tuple[int | None, int | None, int | None, int | None]:
    """Run tactic detection then apply the forcing-line gate (D-02, SC4 single classify path).

    Calls _detect_tactic_for_flaw, then — only when a motif was detected AND
    pv_blob is a non-empty list AND pre_flaw_eval_cp is not None — applies
    apply_forcing_line_filter at the given margin. If the line is non-forcing,
    returns (None, None, None, None) to suppress the motif.

    When pv_blob is None (pre-Phase-142 rows with no stored blob), the gate is
    skipped and the raw detect result is returned unchanged (backward compat).
    The gate is likewise skipped when pre_flaw_eval_cp is None — mate-adjacent
    flaw plies carry eval_mate (not eval_cp), and the forcing-line gate's
    already-winning / still-winning thresholds are cp-based, so it has nothing to
    compare against; the raw detect result stands (RESEARCH A1, accepted).

    D-06 sentinel: an empty list [] means the blob could not be assembled for this
    flaw (e.g. single-legal-move position, analysis gap). The gate is SKIPPED for
    [] — same outcome as pv_blob is None (no suppression, raw kernel result returned).
    Gate condition is `pv_blob is not None and len(pv_blob) > 0`, superseding the
    Phase-143 Pitfall-2 wording that treated [] as a gate-eligible blob requiring
    the one-mover discard. apply_forcing_line_filter itself still rejects [] when
    called directly; the skip here is intentional and upstream of that call.

    blobs_pending (Phase 147, D-01/D-03): an independent, explicitly-passed signal
    (never derived from pv_blob) meaning the continuation blob for this flaw is
    deferred to a later tier-4 pass (the remote go-forward submit path). When True
    AND a motif was detected AND pv_blob is None AND pre_flaw_eval_cp is not None,
    the motif cannot yet be gate-checked, so it is suppressed to NULL rather than
    persisted raw/ungated. This self-heals when the tier-4 D-07 gated retag lands
    with the real blob. Mate-adjacent (pre_flaw_eval_cp is None) and the D-06 []
    sentinel are FINAL cases and are NEVER suppressed by this branch.
    """
    motif, piece, conf, depth = _detect_tactic_for_flaw(
        n, fen_map, positions, pv_by_ply, orientation
    )
    if (
        motif is not None
        and pv_blob is not None
        and len(pv_blob) > 0
        and pre_flaw_eval_cp is not None
    ):
        solver_color = _solver_color_for(n, orientation)
        # Bug B: pass the detected firing depth so only the solver nodes up to the
        # tactic's firing point need be forced (the conversion tail is exempt).
        if not apply_forcing_line_filter(
            pv_blob, solver_color, pre_flaw_eval_cp, firing_depth=depth, margin=margin
        ):
            return None, None, None, None
    if blobs_pending and motif is not None and pv_blob is None and pre_flaw_eval_cp is not None:
        return None, None, None, None
    return motif, piece, conf, depth


def _build_flaw_record(
    n: int,
    mover: Literal["white", "black"],
    severity: FlawSeverity,
    es_before: float,
    es_after: float,
    fen_map: dict[int, str],
    positions: list[GamePosition],
    pv_by_ply: Mapping[int, str] | None = None,
    flaw_pv_blobs: dict[int, tuple[list[PvNode], list[PvNode]]] | None = None,
    blobs_pending: bool = False,
) -> FlawRecord:
    """Build a single FlawRecord for the mover's mistake/blunder at ply N."""
    # `n` is the 0-indexed half-move of the flawed move (positions[n].move_san is
    # the move played FROM ply n — see zobrist.py). fen_map[k] is the board AFTER
    # k half-moves (fen_map[0] = start), so the position BEFORE the flawed move is
    # fen_map[n] (n half-moves already played), NOT fen_map[n - 1]. Using n - 1
    # rendered the miniboard one ply too early (decision point off by one move).
    # This makes the miniboard show the decision point and lets the frontend
    # resolve move_san → arrow squares.
    # Extract MultiPV-2 blobs for this flaw ply (None when not in dict → gate skips).
    blob_pair = flaw_pv_blobs.get(n) if flaw_pv_blobs is not None else None
    allowed_pv_blob: list[PvNode] | None = blob_pair[0] if blob_pair is not None else None
    missed_pv_blob: list[PvNode] | None = blob_pair[1] if blob_pair is not None else None
    # pre_flaw_eval_cp: white-perspective eval_cp BEFORE the flaw move, used by the
    # gate's already-winning reject (D-08). BUG FIX: this previously read positions[n],
    # which is the eval AFTER the flaw move (see _run_all_moves_pass line 348:
    # "positions[N].eval_cp = eval AFTER move N"). Feeding the post-blunder eval made
    # the already-winning reject fire on exactly the strongest allowed tactics — a big
    # blunder swings the solver past +300, so the gate discarded it as "already winning"
    # even when the solver was losing a move earlier. The pre-flaw board is positions[n-1]
    # (the position the flaw move was played FROM). Same value used for both orientations.
    pre_flaw_eval_cp: int | None = positions[n - 1].eval_cp if 1 <= n < len(positions) else None
    # allowed_* pass: detect tactic from flaw_ply+1 PV (the refutation of the flaw).
    # pov = the refuting side (board_after_flaw.turn), per D-03.
    # Routes through _classify_tactic_gated (single classify path, SC4 no-drift, D-02).
    allowed_motif_int, allowed_piece, allowed_confidence, allowed_depth = _classify_tactic_gated(
        n,
        fen_map,
        positions,
        "allowed",
        allowed_pv_blob,
        pre_flaw_eval_cp,
        pv_by_ply,
        blobs_pending=blobs_pending,
    )
    # missed_* pass: detect tactic from flaw_ply PV (the "instead-of" line).
    # pov = board_before.turn = the mover (the flaw-maker, who should have played this line).
    # Reuses the same dispatcher + relevance gate unchanged (D-04).
    missed_motif_int, missed_piece, missed_confidence, missed_depth = _classify_tactic_gated(
        n,
        fen_map,
        positions,
        "missed",
        missed_pv_blob,
        pre_flaw_eval_cp,
        pv_by_ply,
        blobs_pending=blobs_pending,
    )
    # BUGFIX (Phase 148, D-02): fen_map now stores the full board.fen() (side-to-move,
    # castling, en-passant) for detector-internal PV replay — but FlawRecord.fen /
    # game_flaws.fen is a persisted, API-facing column whose contract (piece-placement
    # only; downstream reconstructs side-to-move from ply parity — see
    # app/schemas/library.py TacticLinesResponse.position_fen) is explicitly OUT of
    # scope for this fix (D-02: "detector-internal map only"). Split off the
    # piece-placement field to keep that contract unchanged.
    fen_before_flaw = fen_map.get(n, "")
    board_fen_only = fen_before_flaw.split(" ")[0] if fen_before_flaw else ""
    return FlawRecord(
        ply=n,
        fen=board_fen_only,
        side=mover,
        severity=severity,
        tags=[],
        es_before=es_before,
        es_after=es_after,
        move_san=positions[n].move_san,
        allowed_tactic_motif_int=allowed_motif_int,
        allowed_tactic_piece=allowed_piece,
        allowed_tactic_confidence=allowed_confidence,
        allowed_tactic_depth=allowed_depth,
        missed_tactic_motif_int=missed_motif_int,
        missed_tactic_piece=missed_piece,
        missed_tactic_confidence=missed_confidence,
        missed_tactic_depth=missed_depth,
    )


def _move_time(
    positions: list[GamePosition],
    n: int,
    increment: float,
) -> float | None:
    """Return move time in seconds for the mover at ply N, or None if unavailable.

    Same-side clock is two plies back (Pitfall 2 in RESEARCH — N-1 is the
    opponent's clock). Returns None for first moves (n < 2), when either
    clock is null, or when the computed time is negative (a clock anomaly).

    Formula: prev_same_side_clock - clock_after_move + increment
    (increment is added when the move is completed, so clock_after already
    reflects the pre-increment state before adding increment back).
    """
    if n < 2:
        return None
    prev_clock = positions[n - 2].clock_seconds
    curr_clock = positions[n].clock_seconds
    if prev_clock is None or curr_clock is None:
        return None
    move_time = prev_clock - curr_clock + increment
    # WR-05 fix: a negative move time is physically impossible (the player's own
    # clock cannot gain more than the increment between their moves) and signals
    # inconsistent/corrupt clock data. Treat it as unavailable rather than letting
    # it satisfy `move_time < fast_move_threshold` and mislabel the move as hasty.
    if move_time < 0:
        return None
    return move_time


def _classify_tempo(
    move_time: float | None,
    clock_after: float | None,
    base_time: int | None,
) -> TempoTag | None:
    """Return at most one tempo tag for a flaw, or None when clock data is unavailable.

    Returns one of {low-clock, hasty, unrushed}, or None when clock_after or
    move_time is unavailable (no misleading fallback — per the at-most-one rule in
    flaw-tag-definitions.md §"Structural rule: tempo is optional").

    Priority: low-clock > hasty > unrushed.

    Relative thresholds are used when base_time is available (relative-to-base-clock
    is context-aware — a 5s move is hasty in classical but normal in bullet).
    Absolute fallback values are used when base_time is absent or zero.
    All threshold values are [ASSUMED] initial defaults; tunable on-the-fly.
    """
    if clock_after is None or move_time is None:
        return None

    # Pick thresholds — relative when base_time available (guard against div-by-zero)
    if base_time and base_time > 0:
        low_clock_threshold = base_time * TIME_PRESSURE_CLOCK_FRACTION
        fast_move_threshold = base_time * HASTY_MOVE_FRACTION
    else:
        low_clock_threshold = TIME_PRESSURE_CLOCK_ABS_SECONDS
        fast_move_threshold = HASTY_MOVE_ABS_SECONDS

    if clock_after < low_clock_threshold:
        return "low-clock"
    if move_time < fast_move_threshold:
        return "hasty"
    return "unrushed"


def _is_miss(n: int, all_moves: dict[int, _MoveEntry]) -> bool:
    """Return True if opponent's move at ply N-1 was a mistake or blunder.

    Requires the all-moves classification pass covering both colors (Pitfall 5).
    A miss means the user's error followed immediately after an opponent error,
    suggesting the user may have been rattled or exploiting what they thought
    was a free recovery.
    """
    opponent_n = n - 1
    if opponent_n < 1:
        return False
    entry = all_moves.get(opponent_n)
    if entry is None:
        return False
    opp_severity = entry[1]
    return opp_severity in ("mistake", "blunder")


def _is_unpunished(
    n: int,
    all_moves: dict[int, _MoveEntry],
    severity: FlawSeverity,
    user_result: Literal["win", "draw", "loss"],
) -> bool:
    """Return True when a user BLUNDER at ply N went UNPUNISHED by the opponent.

    lucky = user's blunder that the opponent did NOT capitalize on, so the
    user got away with it. Only applies to blunders (Pitfall 6 in RESEARCH —
    applying to inaccuracies and mistakes would produce a noise-heavy flood).

    A blunder is "unpunished" when the opponent's immediate reply at N+1 was itself
    a mistake or blunder: the user's expected score dropped on their blunder, then
    recovered because the opponent failed to find the punishing line. (ES is
    zero-sum across colors, so an opponent error == the user's eval bouncing back.)

    Bug fix (2026-06-07): this previously returned the INVERSE — it tagged a
    blunder whenever the opponent did NOT err, i.e. when the opponent played a fine
    move and *capitalized*. That fired on the common case (opponents usually reply
    sensibly), tagging ~42% of all blunders as "lucky escapes" and, worst of all,
    flagging fatal blunders where the opponent calmly played the winning/mating
    continuation (e.g. lichess 19BMxZnj: blunder into mate, opponent plays the
    mate move, user resigns). A lucky escape is the opposite: the opponent slipped.

    End-of-game (no opponent move at N+1) counts as a lucky escape only when the
    user did NOT lose — a blunder followed by the user resigning or flagging is a
    loss, not an escape (the opponent never had to punish because the user
    conceded). user_result != "loss" keeps the genuine end-of-game escapes (the
    blunder was actually mate, the game drew, or the opponent resigned anyway).
    """
    if severity != "blunder":
        return False
    opp_n = n + 1
    entry = all_moves.get(opp_n)
    if entry is None:
        # End of game — a lucky escape only if the user didn't lose (a loss here
        # means the user resigned/flagged right after blundering, not an escape).
        return user_result != "loss"
    opp_severity = entry[1]
    # Unpunished == the opponent erred in reply, letting the user's eval recover.
    return opp_severity in ("mistake", "blunder")


def _classify_impact(es_before: float, es_after: float) -> Literal["reversed", "squandered"] | None:
    """Most-severe-wins outcome-independent impact ladder (flaw-tag-definitions.md §Impact).

    At most one tag; most-severe is checked first so a 0.90→0.25 swing returns only
    "reversed" (not "squandered"). Replaces the prior outcome-dependent helper that
    keyed off the final game result — impact is now result-independent (computed
    entirely from es_before/es_after).

    Boundary convention: >= entry / <= exit (inclusive on both ends, per doc prose
    "or below"; differs from the prior strict < exit — Pitfall 4).

    Rungs:
      reversed   — es_before >= WINNING_LINE_ES (0.6762) AND es_after <= LOSING_LINE_ES (0.3238)
                   Full reversal: winning game turned into a losing one.
      squandered — es_before >= FROM_WINNING_ES (0.7511) AND es_after <= SQUANDERED_EXIT_ES (0.5910)
                   AND not reversed. Winning, near-decisive advantage erased back to a slight edge.
    """
    if es_before >= WINNING_LINE_ES and es_after <= LOSING_LINE_ES:
        return "reversed"
    if es_before >= FROM_WINNING_ES and es_after <= SQUANDERED_EXIT_ES:
        return "squandered"
    return None


def _phase_tag(phase: int | None) -> FlawTag:
    """Map the GamePosition.phase integer (0/1/2) to a phase FlawTag.

    Defaults to middlegame for unknown/null phase values (most positions
    are middlegame; this avoids spurious opening or endgame tags).
    """
    if phase == 0:
        return "opening"
    if phase == 2:
        return "endgame"
    return "middlegame"


def _build_tags(
    n: int,
    severity: FlawSeverity,
    es_before: float,
    es_after: float,
    positions: list[GamePosition],
    all_moves: dict[int, _MoveEntry],
    user_result: Literal["win", "draw", "loss"],
    increment: float,
    base_time: int | None,
) -> list[FlawTag]:
    """Assemble the ordered attribution tags list for one user flaw at ply N.

    Tag order: impact (reversed/squandered), miss, lucky, phase, tempo.
    Tags are additive and orthogonal. At most one impact tag and at most one tempo
    tag are present (tempo absent when clock data is unavailable).

    NOTE: user_result is still required here — _is_unpunished (lucky
    end-of-game rule) reads it. Only the impact branch no longer uses it.
    """
    tags: list[FlawTag] = []

    impact = _classify_impact(es_before, es_after)
    if impact is not None:
        tags.append(impact)

    if _is_miss(n, all_moves):
        tags.append("miss")

    if _is_unpunished(n, all_moves, severity, user_result):
        tags.append("lucky")

    tags.append(_phase_tag(positions[n].phase))

    clock_after = positions[n].clock_seconds
    move_time = _move_time(positions, n, increment)
    tempo = _classify_tempo(move_time, clock_after, base_time)
    if tempo is not None:
        tags.append(tempo)

    return tags


def _resolve_increment(game: Game) -> float:
    """Return the increment in seconds for this game.

    Single source of truth for increment resolution (Phase 109 — extracted
    from the inline block in classify_game_flaws to enable reuse by the
    eval chart builder in library_service.py).

    Priority:
    1. game.increment_seconds when explicitly stored (already parsed at import time).
    2. Parsed from game.time_control_str via parse_base_and_increment.
    3. 0.0 fallback (no increment info available).
    """
    if game.increment_seconds is not None:
        return game.increment_seconds
    if game.time_control_str:
        _, parsed_inc = parse_base_and_increment(game.time_control_str)
        if parsed_inc is not None:
            return parsed_inc
    return 0.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def classify_game_flaws(
    game: Game,
    positions: list[GamePosition],
    pv_by_ply: Mapping[int, str] | None = None,
    flaw_pv_blobs: dict[int, tuple[list[PvNode], list[PvNode]]] | None = None,
    blobs_pending: bool = False,
) -> GameFlawsResult:
    """Derive all user flaws from stored per-ply evals.

    Args:
        game: Game row with result, user_color, base_time_seconds,
              increment_seconds, pgn.
        positions: All GamePosition rows for this game, ordered by ply ASC.
            Load via flaws_repository.fetch_game_positions_ordered.
        pv_by_ply: optional {ply -> pv_string} override for tactic detection
            (260618-aiq). The in-process eval drain passes freshly-computed PVs
            here because they are not yet written to game_positions at classify
            time; without it the live drain would tag every flaw NULL. The
            backfill path omits it and reads PVs from positions[n+1].pv.
        flaw_pv_blobs: optional {flaw_ply -> (allowed_blob, missed_blob)} mapping
            of MultiPV-2 PvNode blobs built in memory by the eval drain (Phase 142).
            When provided, _build_flaw_record routes tactic classification through
            _classify_tactic_gated which applies the forcing-line gate (D-02, SC4).
            None (default) preserves the pre-Phase-143 gate-free behavior.
        blobs_pending: Phase 147 (D-01/D-03) — independent signal, defaulting to
            False and NEVER derived from flaw_pv_blobs, meaning the continuation
            blob for every flaw in this game is deferred to a later tier-4 pass
            (the remote go-forward submit path). When True, cp-based flaws that
            cannot yet be gate-checked (no blob, pre_flaw_eval_cp not None) are
            suppressed to NULL instead of persisted raw/ungated; mate-adjacent and
            D-06 []-sentinel flaws are FINAL cases and keep their raw tag.

    Returns:
        list[FlawRecord] for analyzed games — one entry per user mistake or
        blunder (inaccuracies are count-only, NOT emitted). An inaccuracy-only
        analyzed game returns an empty list, distinct from GameNotAnalyzed.

        GameNotAnalyzed when eval coverage < EVAL_COVERAGE_MIN (chess.com games,
        unanalyzed lichess games). Never returns a false zero-flaw game (LIBG-02).
    """
    # Coverage gate: return early for unanalyzed games (chess.com / no evals)
    coverage = _compute_eval_coverage(positions)
    if coverage < EVAL_COVERAGE_MIN:
        return GameNotAnalyzed(reason="no_engine_analysis", eval_coverage=coverage)

    # Build FEN map once and reuse for all flaw records
    fen_map = _recompute_fen_map(game.pgn)

    # All-moves pass: classify both colors (needed for miss/unpunished adjacency)
    all_moves = _run_all_moves_pass(positions)

    # Resolve increment once via shared helper (Phase 109: single source of truth).
    increment = _resolve_increment(game)

    # Phase 113 (D-06 / FLAWX-02): emit FlawRecords for BOTH movers (player and opponent).
    # The previous filter `if mover != user_color: continue` is DROPPED so the kernel
    # records both sides at zero added engine cost (the all-moves pass already evaluates
    # both colors). Readers that need player-only data use is_opponent_expr() at query time
    # (CONTEXT D-01; RESEARCH Pitfall 3 — do not scatter parity math across query sites).
    #
    # Per-mover subject_result: the lucky end-of-game rule (_is_unpunished) checks
    # `subject_result != "loss"`. For opponent flaws this must be the opponent's result,
    # not the player's. Passing game.user_color here would mark any opponent end-of-game
    # blunder in a game the player won as "lucky" — a logic error (RESEARCH Pitfall 2).
    # Fix: call derive_user_result(game.result, mover) once per flaw instead of once
    # globally at the top of classify_game_flaws.
    flaws: list[FlawRecord] = []
    for n, (mover, severity, es_before, es_after) in all_moves.items():
        if severity not in ("mistake", "blunder"):
            # Inaccuracies are count-only per the 2026-06-05 amendment
            continue
        flaw = _build_flaw_record(
            n,
            mover,
            severity,
            es_before,
            es_after,
            fen_map,
            positions,
            pv_by_ply,
            flaw_pv_blobs,
            blobs_pending=blobs_pending,
        )
        # Per-mover subject_result drives the lucky tag correctly for both sides (D-05).
        subject_result = derive_user_result(game.result, mover)
        flaw["tags"] = _build_tags(
            n,
            severity,
            es_before,
            es_after,
            positions,
            all_moves,
            subject_result,
            increment,
            game.base_time_seconds,
        )
        flaws.append(flaw)

    return flaws


def count_game_severities(
    game: Game,
    positions: list[GamePosition],
) -> SeverityCounts | GameNotAnalyzed:
    """Count per-game inaccuracy/mistake/blunder over the USER's moves.

    The count-only sibling of classify_game_flaws. It exposes the inaccuracy
    count that the FlawRecord path deliberately omits (the kernel emits M+B only),
    so the Games-list card can show full B/M/I per game (LIBG-08). No tags, no
    FEN recompute — pure tally.

    Args:
        game: Game row (only user_color is read here).
        positions: All GamePosition rows for this game, ordered by ply ASC.

    Returns:
        SeverityCounts {inaccuracy, mistake, blunder} restricted to the user's
        moves (mover == game.user_color, parity per _run_all_moves_pass) for an
        analyzed game.

        GameNotAnalyzed when eval coverage < EVAL_COVERAGE_MIN — the IDENTICAL
        gate as classify_game_flaws, so analyzed/unanalyzed classification is
        consistent across the two entry points (chess.com / unanalyzed lichess
        games surface "no engine analysis" rather than a false 0/0/0).
    """
    # Coverage gate: identical to classify_game_flaws (same shape on miss).
    coverage = _compute_eval_coverage(positions)
    if coverage < EVAL_COVERAGE_MIN:
        return GameNotAnalyzed(reason="no_engine_analysis", eval_coverage=coverage)

    # Reuse the kernel's per-ply classification pass — no severity-math fork.
    all_moves = _run_all_moves_pass(positions)

    user_color = game.user_color
    counts = SeverityCounts(inaccuracy=0, mistake=0, blunder=0)
    for mover, severity, _es_before, _es_after in all_moves.values():
        if mover != user_color:
            continue
        if severity is None:
            continue
        counts[severity] += 1
    return counts
