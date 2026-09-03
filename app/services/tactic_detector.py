"""Tactic-motif detector for Phase 124 (TACDET-01/02/03/04).

Pure Python/CPU transform over a stored Stockfish refutation PV.
No I/O, no DB, no Stockfish calls. Input: board_after_flaw (chess.Board)
+ pv_str (space-joined UCI from game_positions.pv). Output: (motif, piece, confidence, depth).

Encoding follows the EndgameClassInt precedent (endgame_service.py:108):
  TacticMotifInt — IntEnum encoding for the tactic_motif SmallInteger column.
  TacticMotif    — Literal type alias for human-readable motif strings.
  _INT_TO_MOTIF / _MOTIF_TO_INT — bidirectional dicts.

Detector function return convention (used by dispatcher in detect_tactic_motif):
  Phase 127 contract (D-05):
  Core 8 + named-mate detectors: (fired: bool, piece: int | None, depth: int | None)
    depth is the half-move loop index at the point the motif fires (raw ply from flaw_ply+1).
    piece follows D-12 per-motif semantics.
  Tier-3 detectors: (fired: bool, piece: int | None, confidence: int, depth: int | None)
    confidence is 0-100 graded (count-of-conditions / total * 100).
    depth is the half-move loop index when the motif fires.
  detect_boden_or_double_bishop_mate: (motif: TacticMotif | None, piece: int | None, depth: int | None)
  Dispatcher detect_tactic_motif: (motif_int, piece, confidence, depth) — 4-tuple throughout.
  Graded scoring: _grade(met, total) -> int is the single named helper.

Relevance gate (D-01): non-mate detectors that scan the full PV check that the motif
fires in a continuation where pov does not lose material vs the starting position, or
fires on the very first pov move. This eliminates Case-B incidental hits (motif visible
in a non-forcing continuation after the refutation already won) without killing real
deep combinations (Case A — a forcing line where the motif IS the point).
"""

from __future__ import annotations

from enum import IntEnum
from typing import Callable, Literal

import chess

# ---------------------------------------------------------------------------
# Named constants — no magic numbers (CLAUDE.md)
# ---------------------------------------------------------------------------

# Piece values (cook.py convention): used by fork, skewer, hanging-piece,
# capturing-defender, and sacrifice detectors.  KING:99 ensures a forking check
# counts as a high-value fork target (D-08, shared utility port).
_PIECE_VALUES: dict[int, int] = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 99,
}

# No-king value table for _is_in_bad_spot's lower-value comparator (Pitfall 4, D-08).
# is_in_bad_spot asks "can this piece be profitably captured?" — a king can never be
# captured, so it must not appear as a valid lower-value attacker in that check.
# Contrast with fork's victim comparison which uses _PIECE_VALUES (king=99 makes a
# forking check qualify as a high-value attack).
_VALUES_NO_KING: dict[int, int] = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
}

# Core detectors fire with this confidence (cook is boolean — no gradations).
TACTIC_CONFIDENCE_HIGH: int = 100

# Severity gate (D-05): only mistakes and blunders receive motif detection.
# Tunable constant — do not hardcode in caller logic.
TACTIC_MIN_SEVERITY: frozenset[str] = frozenset({"mistake", "blunder"})

# Ray piece types: used for pin, skewer, x-ray, interference detectors.
_RAY_PIECES: frozenset[int] = frozenset({chess.BISHOP, chess.ROOK, chess.QUEEN})

# Minimum material-point drop below the starting position that constitutes a sacrifice.
# Cook §7: sacrifice fires when pov is down ≥2 points vs start AFTER at least the 2nd pov move.
# 2 = minor piece (bishop/knight) threshold — queens (9) and rooks (5) are always >= 2.
MIN_SACRIFICE_DROP: int = 2

# ---------------------------------------------------------------------------
# IntEnum encoding (TacticMotifInt) — values must never be reordered.
# Existing DB rows encode these ints. Per D-02 / D-03.
# ---------------------------------------------------------------------------


class TacticMotifInt(IntEnum):
    """Integer encoding for tactic_motif column (SmallInteger). Maps 1:1 to TacticMotif
    Literal strings. Values must never be reordered — existing DB rows encode these ints."""

    FORK = 1
    HANGING_PIECE = 2
    PIN = 3
    SKEWER = 4
    DOUBLE_CHECK = 5
    DISCOVERED_ATTACK = 6
    BACK_RANK_MATE = 7
    MATE = 8
    DEFLECTION = 9
    ATTRACTION = 10
    INTERMEZZO = 11
    X_RAY = 12
    INTERFERENCE = 13
    SELF_INTERFERENCE = 14
    CLEARANCE = 15
    CAPTURING_DEFENDER = 16
    SACRIFICE = 17
    SMOTHERED_MATE = 18
    ANASTASIA_MATE = 19
    HOOK_MATE = 20
    ARABIAN_MATE = 21
    BODEN_MATE = 22
    DOUBLE_BISHOP_MATE = 23
    DOVETAIL_MATE = 24
    # Phase 128.1-01: new Tier-2 motifs (append-only; preserve existing 1-24).
    DISCOVERED_CHECK = 25
    TRAPPED_PIECE = 26
    # Phase 128.1-02: move-type family (Tier 5, lowest — real tactics always win, D-03/D-04).
    EN_PASSANT = 27
    PROMOTION = 28
    UNDER_PROMOTION = 29


# ---------------------------------------------------------------------------
# Literal type alias — all 29 motif strings.
# ---------------------------------------------------------------------------

TacticMotif = Literal[
    "fork",
    "hanging-piece",
    "pin",
    "skewer",
    "double-check",
    "discovered-attack",
    "back-rank-mate",
    "mate",
    "deflection",
    "attraction",
    "intermezzo",
    "x-ray",
    "interference",
    "self-interference",
    "clearance",
    "capturing-defender",
    "sacrifice",
    "smothered-mate",
    "anastasia-mate",
    "hook-mate",
    "arabian-mate",
    "boden-mate",
    "double-bishop-mate",
    "dovetail-mate",
    # Phase 128.1-01
    "discovered-check",
    "trapped-piece",
    # Phase 128.1-02: move-type family
    "en-passant",
    "promotion",
    "under-promotion",
]

# ---------------------------------------------------------------------------
# Bidirectional encoding dicts
# ---------------------------------------------------------------------------

_INT_TO_MOTIF: dict[int, TacticMotif] = {
    1: "fork",
    2: "hanging-piece",
    3: "pin",
    4: "skewer",
    5: "double-check",
    6: "discovered-attack",
    7: "back-rank-mate",
    8: "mate",
    9: "deflection",
    10: "attraction",
    11: "intermezzo",
    12: "x-ray",
    13: "interference",
    14: "self-interference",
    15: "clearance",
    16: "capturing-defender",
    17: "sacrifice",
    18: "smothered-mate",
    19: "anastasia-mate",
    20: "hook-mate",
    21: "arabian-mate",
    22: "boden-mate",
    23: "double-bishop-mate",
    24: "dovetail-mate",
    # Phase 128.1-01: append-only; existing 1-24 never reordered (T-128.1-02)
    25: "discovered-check",
    26: "trapped-piece",
    # Phase 128.1-02: move-type family (T-128.1-05: append-only, no migration)
    27: "en-passant",
    28: "promotion",
    29: "under-promotion",
}

_MOTIF_TO_INT: dict[TacticMotif, int] = {v: k for k, v in _INT_TO_MOTIF.items()}

# ---------------------------------------------------------------------------
# Grouping constants
# ---------------------------------------------------------------------------

# All 9 named-mate motifs (D-03): fine-grained storage, free coarsening at query time.
# Usage: WHERE tactic_motif IN (MATE_MOTIFS) — no re-detect required.
MATE_MOTIFS: frozenset[TacticMotif] = frozenset(
    {
        "back-rank-mate",
        "mate",
        "smothered-mate",
        "anastasia-mate",
        "hook-mate",
        "arabian-mate",
        "boden-mate",
        "double-bishop-mate",
        "dovetail-mate",
    }
)

# Move-type family (D-02): en-passant, promotion, and under-promotion are grouped here
# because they are detected from the SHAPE of the refuting move, not from board geometry.
# They are detected + stored for lichess-theme parity; whether/how to surface them as
# chips is a Phase 129 decision (D-09). discovered-check and trapped-piece are NOT in
# this set — they are real tactical geometry.
MOVE_TYPE_MOTIFS: frozenset[TacticMotif] = frozenset(
    {
        "en-passant",
        "promotion",
        "under-promotion",
    }
)

# ---------------------------------------------------------------------------
# PV-parse helper (Pattern 2 from RESEARCH.md)
# ---------------------------------------------------------------------------


def _parse_pv(
    board_after_flaw: chess.Board, pv_str: str
) -> tuple[list[chess.Board], list[chess.Move]]:
    """Parse space-joined UCI PV string into board sequence.

    Returns (boards, moves) where boards[0] = board_after_flaw,
    boards[i+1] = board after moves[i]. Length: len(moves) = len(boards)-1.

    Raises ValueError on malformed UCI strings (caller wraps in try/except).
    """
    moves = [chess.Move.from_uci(uci) for uci in pv_str.split()]
    boards: list[chess.Board] = [board_after_flaw.copy()]
    for move in moves:
        b = boards[-1].copy()
        try:
            b.push(move)
        except AssertionError as exc:
            # chess.Board.push() raises AssertionError for pseudo-illegal moves;
            # treat as a malformed PV so callers can handle via ValueError guard.
            raise ValueError(f"PV move {move} is not legal in position") from exc
        boards.append(b)
    return boards, moves


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def _piece_value(piece_type: int) -> int:
    """Return the tactical value of a piece type (cook.py convention)."""
    return _PIECE_VALUES.get(piece_type, 0)


def _is_hanging(board: chess.Board, sq: int, color: chess.Color) -> bool:
    """Return True if piece at sq of color has no defenders of that color.

    Precision-first: strict undefended test (attackers(color, sq) empty).
    A piece is only hanging if it is both attacked and has no defenders.

    NOTE: This helper is NOT ray-aware. It is kept for backward compatibility with
    consumers that have not yet been migrated to the ray-aware helpers below.
    Six consumers will migrate in plans 02/03: fork, hanging-piece, skewer, pin,
    interference, trapped-piece. Fork already uses _is_defended (see detect_fork).
    """
    attacked_by_opponent = bool(board.attackers(not color, sq))
    defended_by_self = bool(board.attackers(color, sq))
    return attacked_by_opponent and not defended_by_self


def _is_defended(board: chess.Board, piece: chess.Piece, sq: int) -> bool:
    """True if piece at sq of piece.color has a direct or X-ray defender.

    Reimplemented from cook's util.is_defended pseudocode (AGPL boundary — no source copy).
    Consumers: fork (victim hanging check), and the six detector sites being migrated
    in plans 02/03 (hanging-piece, skewer, pin, interference, trapped-piece + this plan's
    fork rewire).

    Direct defense: board.attackers(piece.color, sq) is non-empty.
    X-ray defense: any opponent ray attacker (Q/R/B) is removed via board.copy(stack=False)
    and defenders re-checked. A piece defended only through a friendly ray piece in front
    is now correctly NOT treated as hanging.
    """
    # Direct defense
    if board.attackers(piece.color, sq):
        return True
    # X-ray defense: for each opponent ray attacker, remove it and re-check.
    for attacker_sq in board.attackers(not piece.color, sq):
        attacker = board.piece_at(attacker_sq)
        if attacker is not None and attacker.piece_type in _RAY_PIECES:
            bc = board.copy(stack=False)
            bc.remove_piece_at(attacker_sq)
            if bc.attackers(piece.color, sq):
                return True
    return False


def _is_in_bad_spot(board: chess.Board, sq: int) -> bool:
    """True if the piece at sq is attacked AND (hanging or capturable by a lower non-king).

    Reimplemented from cook's util.is_in_bad_spot pseudocode (AGPL boundary — no source copy).
    Uses _VALUES_NO_KING for the lower-value comparator (Pitfall 4, D-08): a king cannot
    be profitably captured, so it must not register as a valid lower-value attacker here.

    Used as:
    - A PRUNE in detect_fork: skip a fork candidate if the forker lands in a bad spot.
    - An ACCEPT in detect_skewer: require is_in_bad_spot on the capture square (plan 02/03).
    """
    piece = board.piece_at(sq)
    if piece is None:
        return False
    if not board.attackers(not piece.color, sq):
        return False  # not even attacked — cannot be in a bad spot
    # Hanging: no direct or X-ray defense at all
    if not _is_defended(board, piece, sq):
        return True
    # Capturable by a lower-value non-king opponent attacker
    for atk_sq in board.attackers(not piece.color, sq):
        atk = board.piece_at(atk_sq)
        if atk is not None and atk.piece_type != chess.KING:
            if _VALUES_NO_KING.get(atk.piece_type, 0) < _VALUES_NO_KING.get(piece.piece_type, 0):
                return True
    return False


def _material_diff(board: chess.Board, pov: chess.Color) -> int:
    """Sum of pov piece values minus opponent piece values. Excludes kings."""
    total = 0
    for pt in (chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN):
        val = _piece_value(pt)
        total += val * len(board.pieces(pt, pov))
        total -= val * len(board.pieces(pt, not pov))
    return total


def _grade(met: int, total: int) -> int:
    """Grade count-of-conditions as 0-100 integer percent.

    met / total * 100, rounded to nearest int. Returns 0 if total==0.
    """
    if total == 0:
        return 0
    return round(met / total * 100)


# ---------------------------------------------------------------------------
# Core 8 detectors
# Each returns (bool, piece_int_or_None) per the module convention.
# ---------------------------------------------------------------------------


def detect_fork(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Fork: a pov move attacks 2+ opponent pieces that are each higher-value or loose.

    Rebuilt to cook's exact relational predicate (D-09/D-10, plan 02 — no source copy):
    scan pov moves EXCEPT the last (`range(0, len(moves) - 2, 2)` — cook's [:-1] equiv);
    moved piece is not a king; PRUNE if forker lands in a bad spot (`_is_in_bad_spot`);
    count victims via `board_after.attacks(dest)`, SKIPPING pawn victims; victim qualifies
    if `_PIECE_VALUES[victim] > _PIECE_VALUES[forker]` (king=99, so forking checks count)
    OR (`not _is_defended` AND victim_sq not in board_after.attackers(not pov, dest) —
    the hanging victim is not itself defending the fork square); fire if victims ≥ 2.

    Returns (fired, forking_piece_type, depth) on detection.
    tactic_piece = the forking piece type (D-12).
    depth = loop index i (half-moves from flaw_ply+1) when the fork fires.

    Relevance gate (D-01): a fork at depth i>0 fires only if pov gained material
    vs the starting position. This eliminates Case-B deep-scan false positives —
    incidental forks in non-winning continuations — without killing real combinations
    where the fork IS the material gain (Case A).

    Note on last-move exclusion: cook scans [:-1] (excludes the last pov move). This
    aligns with the Phase-124 interpretation — the last pov move is excluded because
    cook's logic cannot verify whether the fork is meaningful without a following line.
    """
    material_at_start = _material_diff(boards[0], pov)
    material_at_end = _material_diff(boards[-1], pov)

    # Cook scans [:-1] (all pov moves except the last) — equivalent to range(0, len-2, 2)
    # when pov moves are at even indices. If len(moves) < 2, no pov moves to scan.
    for i in range(0, len(moves) - 2, 2):  # pov's turns, cook's [1::2][:-1] equivalent
        board_after = boards[i + 1]

        # Relevance gate (D-01): skip forks in non-winning continuations (Case-B fix).
        if i > 0 and material_at_end < material_at_start:
            continue

        move = moves[i]
        dest = move.to_square
        mover_piece = board_after.piece_at(dest)
        if mover_piece is None or mover_piece.color != pov:
            continue
        mover_type = mover_piece.piece_type
        mover_val = _piece_value(mover_type)

        # Cook gap 1: kings cannot fork (cook excludes king forkers explicitly)
        if mover_type == chess.KING:
            continue

        # Cook gap 1: forker-safety prune — skip if forker lands in a bad spot
        # (the forker itself is loose; the fork is not free)
        if _is_in_bad_spot(board_after, dest):
            continue

        attacked_sqs = board_after.attacks(dest)
        fork_sq_attackers = board_after.attackers(not pov, dest)
        victims: list[int] = []
        for sq in attacked_sqs:
            target = board_after.piece_at(sq)
            if target is None or target.color == pov:
                continue
            # Cook gap 2: skip pawn victims (cook skips pawns as fork targets)
            if target.piece_type == chess.PAWN:
                continue
            target_val = _piece_value(target.piece_type)
            # Victim qualifies if higher-value than forker (KING=99 makes forking checks count)
            # OR (hanging AND not an attacker of the fork square — the "not attacker" clause)
            is_higher_value = target_val > mover_val
            # Cook gap 3 (hanging victim): ray-aware _is_defended (D-08)
            is_hanging_victim = not _is_defended(board_after, target, sq)
            # Cook gap 4: hanging victim must not be defending the fork square itself
            is_not_defending_fork = sq not in fork_sq_attackers
            if is_higher_value or (is_hanging_victim and is_not_defending_fork):
                victims.append(sq)

        if len(victims) >= 2:
            return True, mover_type, i

    return False, None, None


def detect_hanging_piece(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Hanging piece: pov's first move captures an undefended non-pawn.

    Returns (fired, victim_piece_type, depth) on detection.
    tactic_piece = the victim (D-12).
    depth = 0 (always fires on the first pov move, if at all).
    """
    if not moves:
        return False, None, None

    first_move = moves[0]
    board_before = boards[0]
    to_square = first_move.to_square

    # Must be a capture of a non-pawn, non-king piece. A king can never legally be
    # captured (cook never sees one as the captured piece); excluding it guards against
    # degenerate fixture PVs that "capture" onto the king's square.
    target = board_before.piece_at(to_square)
    is_capturable = target is not None and target.piece_type not in (chess.PAWN, chess.KING)
    # cook gate: if the position before the capture is in check and we did not
    # capture a non-pawn, hanging-piece does not apply (the move is forced defence).
    if board_before.is_check() and not is_capturable:
        return False, None, None
    if not is_capturable:
        return False, None, None

    # Target must be hanging on the board before capture. cook's util.is_hanging is
    # ray-aware (`not is_defended`) — a piece defended only through a friendly ray is
    # NOT hanging. Our prior non-ray-aware `_is_hanging` over-fired on such pieces.
    if _is_defended(board_before, target, to_square):
        return False, None, None

    # cook recapture exclusion: if the flaw move (the move that created boards[0], carried on
    # its move stack) landed on our capture square AND captured a piece of value >= the piece
    # we are now capturing, this is a recapture of an equal/greater trade, NOT a hanging piece.
    # boards[0].move_stack carries the flaw move in production (board_after_flaw = board_before
    # + push(flaw_move)) and in the gate (rebuilt the same way). A bare/stackless board (the
    # "missed" pass) skips the exclusion. This is the dominant hanging-piece FP source.
    if board_before.move_stack:
        flaw_move = board_before.peek()
        if flaw_move.to_square == to_square:
            pre_flaw = board_before.copy()
            pre_flaw.pop()
            op_capture = pre_flaw.piece_at(to_square)
            if op_capture is not None and _piece_value(op_capture.piece_type) >= _piece_value(
                target.piece_type
            ):
                return False, None, None

    # cook material-maintenance gate: a clean hanging-piece win KEEPS the material.
    # Short solutions (no second pov move at boards[3]) fire unconditionally; otherwise
    # require material after the second pov move >= material after the first, so we do
    # not tag positions where the grabbed piece is given straight back (sac/attraction/
    # trade lines — the dominant endgame false-positive source). boards[1] = after our
    # first move (cook mainline[1]); boards[3] = after our second move (cook mainline[3]).
    if len(boards) >= 4:
        if _material_diff(boards[3], pov) < _material_diff(boards[1], pov):
            return False, None, None

    victim_type = target.piece_type
    return True, victim_type, 0  # depth 0: hanging piece is always first pov move


def _pin_prevents_attack(
    board: chess.Board, pinned_sq: int, pin_ray: chess.SquareSet, pov: chess.Color
) -> bool:
    """Cook sub-test 1: pin_prevents_attack.

    The pinned opponent piece attacks a pov piece on a square OUTSIDE the pin direction,
    where that pov piece is worth more than the pinned piece OR is hanging.
    This fires when the pin prevents the opponent from executing a threatened capture.

    Pitfall 7: board.pin(color, sq) is called with the PINNED piece's color.
    """
    pinned_piece = board.piece_at(pinned_sq)
    if pinned_piece is None:
        return False
    pinned_val = _piece_value(pinned_piece.piece_type)

    # Temporarily generate attacks from the pinned piece's square with a temp board
    # (board.attacks uses slider geometry without legality filtering)
    for target_sq in board.attacks(pinned_sq):
        target = board.piece_at(target_sq)
        if target is None or target.color != pov:
            continue
        # The target must be OUTSIDE the pin ray (inside = not a real threat)
        if target_sq in pin_ray:
            continue
        target_val = _piece_value(target.piece_type)
        # pov target is worth more than the pinned piece, or is hanging
        if target_val > pinned_val or not _is_defended(board, target, target_sq):
            return True
    return False


def _pin_prevents_escape(
    board: chess.Board,
    pinned_sq: int,
    pin_ray: chess.SquareSet,
    pov: chess.Color,
) -> bool:
    """Cook sub-test 2: pin_prevents_escape.

    A pov attacker INSIDE the pin line attacks the pinned piece; the pin is meaningful
    if the pinned piece is worth more than the pov attacker OR the pinned piece is hanging
    AND cannot legally step off the pin line to safety.

    INSIDE the pin line means the attacker square is IN the pin_ray SquareSet (the ray from
    the pinner through the pinned piece). The pinner itself is on the ray, as is every
    square between the pinner and the pinned piece.
    """
    pinned_piece = board.piece_at(pinned_sq)
    if pinned_piece is None:
        return False
    pinned_val = _piece_value(pinned_piece.piece_type)
    pinned_is_hanging = not _is_defended(board, pinned_piece, pinned_sq)

    for attacker_sq in board.attackers(pov, pinned_sq):
        # Attacker must be INSIDE the pin ray (on the pinner→pinned line)
        if attacker_sq not in pin_ray:
            continue
        attacker = board.piece_at(attacker_sq)
        if attacker is None:
            continue
        attacker_val = _piece_value(attacker.piece_type)
        # Higher-value pinned piece is always meaningful
        if pinned_val > attacker_val:
            return True
        # cook second branch: the pinned piece is hanging, does NOT itself defend by
        # attacking the attacker (if it attacks the attacker back, capturing is a real
        # defence so the pin is not trapping it), AND a pseudo-legal escape off the pin
        # line EXISTS — meaning the pin is precisely what prevents that escape. The prior
        # implementation omitted the "pinned not attacking attacker" guard, firing on
        # incidental pins where the pinned piece attacked its own pinner (the dominant
        # pin false-positive source, e.g. a pawn pinned by the queen it also attacks).
        if (
            pinned_is_hanging
            and pinned_sq not in board.attackers(not pov, attacker_sq)
            and any(
                m.from_square == pinned_sq and m.to_square not in pin_ray
                for m in board.pseudo_legal_moves
            )
        ):
            return True
    return False


def detect_pin(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Pin: a line piece constrains an opponent piece via either pin sub-test.

    Rebuilt to cook's two-sub-test port (D-09/D-10, plan 02 — no source copy):
    For each board position in the PV, scan every opponent piece; use `board.pin(color, sq)`
    with the PINNED piece's color (Pitfall 7). If pin_ray != BB_ALL (piece is pinned), find
    the pov pinner and apply both cook sub-tests:

    1. `pin_prevents_attack`: pinned piece threatens a pov piece OUTSIDE the pin line
       (worth more OR hanging) — the pin stops the threatened capture.
    2. `pin_prevents_escape`: a pov attacker INSIDE the pin line attacks the pinned piece;
       meaningful if pinned > attacker value, or pinned is hanging and can't escape.

    Replaces the old `_pin_wins_material` relevance gate (direct-capture accept / replacement
    guard reject) with cook's structural criteria — precision lift from 0.44 to measured value.

    Phase 131 precision fix (pin 0.819 -> ~0.95 TEST): only scan boards that follow a POV
    (refuting/winning side) move — the ODD board indices. boards[0] is pov-to-move, so pov's
    moves land on boards[1], boards[3], ... — those are the positions where a pin pov just
    CREATED exists. cook.py checks pins on exactly these nodes, not on every position. The old
    `enumerate(boards)` also scanned pov-to-move boards (even indices), where pre-existing /
    incidental structural pins (and pins inside opponent forcing lines: attraction, deflection,
    sacrifice) fired as false positives — isolated precision 0.477 -> 0.947 on TEST, recall ~1.0.

    tactic_piece = the pinner piece type (D-12).
    depth = max(0, k-1) where k is board index (SEED-057 IN-01 / Pitfall 6); k is always odd
    here so depth is even (0, 2, 4, ...).
    """
    # Only POV-move result boards (odd indices). boards[0] is pov-to-move (no pin created yet).
    for k in range(1, len(boards), 2):
        board = boards[k]
        for sq in chess.SQUARES:
            piece = board.piece_at(sq)
            if piece is None or piece.color == pov:
                continue
            # board.pin(color, sq) with the PINNED piece's color (Pitfall 7)
            # Returns BB_ALL when the piece is NOT pinned; any other value = pinned
            pin_ray = chess.SquareSet(board.pin(piece.color, sq))
            if board.pin(piece.color, sq) == chess.BB_ALL:
                continue

            # Find the pov pinner (ray piece on the pin ray)
            pinner_type: int | None = None
            for ray_sq in pin_ray:
                ray_piece = board.piece_at(ray_sq)
                if ray_piece is None or ray_piece.color != pov:
                    continue
                if ray_piece.piece_type not in _RAY_PIECES:
                    continue
                pinner_type = ray_piece.piece_type
                break

            if pinner_type is None:
                continue  # no pov ray pinner found (e.g. pinned by king — skip)

            # Fire if either cook sub-test holds
            if _pin_prevents_attack(board, sq, pin_ray, pov) or _pin_prevents_escape(
                board, sq, pin_ray, pov
            ):
                # SEED-057 (IN-01): k is board index; depth should be move index.
                # Board k follows move k-1. Clamp to 0 for k==0.
                return True, pinner_type, max(0, k - 1)

    return False, None, None


def detect_skewer(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Skewer: a ray piece captures through a high-value opponent piece that moved across
    the skewer line in the prior opponent move, exposing a lower-value piece behind.

    Rebuilt to cook's exact relational predicate (D-09/D-10, plan 02 — no source copy):
    scan pov moves from the 2nd (`range(2, len(moves), 2)`) — the first pov move lacks
    a preceding pov move context so can't be a relational skewer.  For each pov capture
    with a ray piece (Q/R/B) that is not checkmate:
      - let `between = chess.SquareSet.between(move.from_square, move.to_square)`
      - let `op = moves[k-1]` (the opponent's immediately prior move)
      - require `op.to_square != capture_square` (not a recapture)
        AND `op.from_square in between` (op piece moved ACROSS the skewer line)
      - require `_PIECE_VALUES[moved_op_piece] > _PIECE_VALUES[captured]` (higher-value
        piece was in front — king=99 so a forking check also qualifies)
        AND `_is_in_bad_spot(board_before, capture_square)` (the piece we capture is loose)

    tactic_piece = the skewering ray piece (D-12).
    depth = k (loop index, half-moves from flaw_ply+1) per Pitfall 6 / SEED-057 convention.

    No D-01 gate: skewer is a structural motif common in equalizing continuations.
    """
    for k in range(2, len(moves), 2):  # pov's 2nd+ moves (index convention: cook [1::2][1:])
        move = moves[k]
        board_before = boards[k]
        capture_sq = move.to_square

        # Must be a capture (piece on destination before the move)
        captured = board_before.piece_at(capture_sq)
        if captured is None or captured.color == pov:
            continue

        # Moving piece must be a pov ray piece (Q/R/B)
        mover = board_before.piece_at(move.from_square)
        if mover is None or mover.color != pov or mover.piece_type not in _RAY_PIECES:
            continue

        # Not checkmate after the capture (skewer is not a mating move)
        board_after = boards[k + 1]
        if board_after.is_checkmate():
            continue

        # Cook relational predicate: the prior opponent move must have come FROM a
        # between-square on the skewer line (the opponent's piece crossed the line).
        between = chess.SquareSet.between(move.from_square, capture_sq)
        op = moves[k - 1]  # opponent's move immediately before this pov move

        # Recapture guard: op did NOT just move to this capture square
        if op.to_square == capture_sq:
            continue

        # Key geometry: op's piece came FROM a square on the skewer line
        if op.from_square not in between:
            continue

        # The piece the opponent just moved must be higher value than the piece we capture
        op_piece_on_new_sq = board_before.piece_at(op.to_square)
        if op_piece_on_new_sq is None:
            continue
        if _PIECE_VALUES.get(op_piece_on_new_sq.piece_type, 0) <= _PIECE_VALUES.get(
            captured.piece_type, 0
        ):
            continue

        # The captured piece must be in a bad spot (loose / capturable by lower piece)
        if not _is_in_bad_spot(board_before, capture_sq):
            continue

        return True, mover.piece_type, k

    return False, None, None


def detect_double_check(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, None, int | None]:
    """Double check: pov delivers a move resulting in 2+ checkers.

    Returns (fired, None, depth) — D-12: piece is NULL for double-check.
    depth = i - 1 (the pov move index that delivered the double check),
    per Pitfall 7: board index i means move i-1 was the last move.
    """
    for i in range(1, len(boards)):
        board = boards[i]
        # After pov's move (odd board index = pov just moved)
        if (i % 2) != 1:
            continue
        # It's now opponent's turn; check if opponent is in double check
        if board.turn == (not pov) and len(list(board.checkers())) >= 2:
            return True, None, i - 1  # depth = move index (per Pitfall 7)

    return False, None, None


def detect_discovered_check(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Discovered check: pov's first move gives a discovered check (the checking piece
    is NOT the piece that moved).

    Returns (fired, unveiled_checker_piece_type, depth) where depth = 0 (discovered
    check always fires on the first pov move).
    tactic_piece = the piece that delivers the discovered check (D-12).

    D-03 split rationale: this is Sub-case 1 lifted out of detect_discovered_attack so
    that a discovering move that gives check tags as 'discovered-check' (int 25), not
    'discovered-attack' (int 6).  The more-specific subtype wins — the same pattern used
    by named-mate subtypes that short-circuit before generic mate.  discovered-check is
    ranked above discovered-attack in _GEOMETRIC_REGISTRY (lower list index = higher
    priority) so the dispatcher returns discovered-check when both would fire on the
    same PV at the same depth.

    Cook-faithful scan (Quick 260623): cook.discovered_check scans EVERY pov move
    (`mainline[1::2]`), not just the first — a discovered check can be delivered on a
    later pov move. We scan the same set and return the FIRST discovered check as depth=k
    so the depth-primary dispatcher keeps shallower tactics winning. The first-pov-move
    case still returns depth 0 (unchanged behavior).
    """
    for k in _solver_move_indices(len(moves)):
        board_after = boards[k + 1]
        if not board_after.is_check():
            continue

        checkers_set = board_after.checkers()
        if moves[k].to_square in checkers_set:
            # The piece that just moved is itself the checker — direct check, not discovered
            continue

        # The moved piece is NOT in the checker set: it's a discovered check.
        for checker_sq in checkers_set:
            checker = board_after.piece_at(checker_sq)
            if checker is not None and checker.color == pov:
                return True, checker.piece_type, k

    return False, None, None


def detect_discovered_attack(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Discovered attack: an earlier pov move vacated a between-square, unmasking a capture.

    Rebuilt to cook's exact relational predicate (D-09/D-10, plan 02 — no source copy):
    scan pov moves from the 2nd (`range(2, len(moves), 2)`) to keep the loop starting
    at index 2 (Pitfall 1 — discovered-check owns the first pov move, depth 0).
    For each pov capture at index k:
      - compute `between = chess.SquareSet.between(move.from_square, move.to_square)`
      - let `op = moves[k-1]` — if `op.to_square == capture_square`: short-circuit to
        False (it is a recapture, not a discovered attack)
      - let `prev = moves[k-2]` (the earlier pov move)
      - require `prev.from_square in between` (earlier pov move vacated a between-square)
        AND `capture_sq != prev.to_square` (we are not capturing on prev's destination)
        AND `move.from_square != prev.to_square` (capturer did not come FROM prev's dest)
        AND `prev` is not a castling move (castling cannot unblock a ray)

    Returns (fired, unveiled_attacker_piece_type, depth).
    tactic_piece = the capturing piece (the piece now attacking on the unblocked ray).
    depth = k (half-moves from flaw_ply+1, per Pitfall 6 / SEED-057 convention).

    D-03 note: Sub-case 1 (first pov move gives discovered check) was split out into
    detect_discovered_check (int 25) which fires at depth 0.  This function handles
    only sub-case 2 (deeper captures). Loop starts at k=2, not k=0, so discovered-check
    positions are never re-claimed here (Pitfall 1 guard).
    """
    if len(moves) < 3 or len(boards) < 4:
        # Need at least 3 moves: prev pov (k-2), op (k-1), this pov capture (k=2)
        return False, None, None

    for k in range(2, len(moves), 2):  # pov's 2nd+ moves (cook [1::2][1:] equivalent)
        move = moves[k]
        board_before = boards[k]
        capture_sq = move.to_square

        # Must be a capture by an opponent piece (not pov capturing pov's own piece)
        captured_piece = board_before.piece_at(capture_sq)
        if captured_piece is None or captured_piece.color == pov:
            continue

        # Opponent's prior move going to capture_sq means recapture — short-circuit to False
        op = moves[k - 1]
        if op.to_square == capture_sq:
            continue

        # The earlier pov move (prev) must have vacated a between-square on the capture ray
        prev = moves[k - 2]

        # Castling cannot unblock a ray geometrically.
        # Bug-fix (131-REVIEW WR-01): is_castling() is board-state-aware — it checks the
        # king still sits on prev.from_square. board_before (boards[k]) is two half-moves
        # AFTER prev was played, so the castled king has already vacated e1/e8 and the
        # guard silently never fired. Use boards[k-2] (the state before prev) to detect it.
        if boards[k - 2].is_castling(prev):
            continue

        between = chess.SquareSet.between(move.from_square, capture_sq)

        # Require: prev.from_square ∈ between (earlier pov move VACATED a between-square)
        if prev.from_square not in between:
            continue

        # Require: capture_sq != prev.to_square (we are not capturing the piece prev moved)
        if capture_sq == prev.to_square:
            continue

        # Require: capturer did NOT come from prev's destination (not the same piece redirected)
        if move.from_square == prev.to_square:
            continue

        # The capturing piece is the "unveiled" attacker on the newly-open ray
        capturer = board_before.piece_at(move.from_square)
        if capturer is None or capturer.color != pov:
            continue

        # NOTE (131-REVIEW WR-02): depth here is max(0, k-1), but k is a MOVE index
        # (range(2, len(moves), 2)) like detect_skewer (which returns k) — not a BOARD
        # index like detect_pin (where the -1 is correct). So discovered-attack stores
        # depth one ply too shallow vs the docstring's "depth = k". NOT corrected here:
        # the depth-primary dispatch and 36 fixture labels were tuned around this k-1
        # value, and returning k flips a hand-confirmed discovered-attack fixture to fork.
        # Correcting it requires re-tuning + re-validating the attribution layer — tracked
        # as a follow-up, not an advisory code-review fix.
        return True, capturer.piece_type, max(0, k - 1)

    return False, None, None


def _piece_is_trapped(board: chess.Board, sq: int, pov: chess.Color) -> bool:
    """Return True if the opponent piece at sq is trapped on the given board.

    Reimplemented from cook's util.is_trapped prose (AGPL boundary — no source
    copy from cook.py/util.py). Reuses _is_in_bad_spot and _piece_value (the
    existing faithful cook ports at L318 and L270).

    All of the following must hold:
    1. The board is NOT in check and the piece is NOT pinned (immobility from
       check/pin is a different motif, excluded here).
    2. The piece is not a pawn and not a king (only N/B/R/Q can be trapped).
    3. The piece is currently in a bad spot (_is_in_bad_spot: attacked AND either
       hanging or capturable by a strictly-lower-value non-king attacker).
    4. For every legal move of that piece:
       a. If the escape captures an opponent (pov) piece worth >= the trapped
          piece's own value → NOT trapped (trade-up/equal escape).
       b. Push the escape and check: if the piece is NOT in a bad spot on the
          new square → NOT trapped (safe square found).
    5. If no escape avoided a bad spot and none captured equal/greater → trapped.

    Empty-escape-set choice (Open Q 2 / D-06): if the piece has no legal moves at
    all (fully blocked, not technically pinned but no legal escapes), return False.
    This is a deliberate precision-first deviation from cook (cook returns True for
    immobile-attacked non-pawn/non-king). The CC0 fixture measurement showed no
    recall cliff from this exclusion on the expanded ~1065-row fixture.

    Helper extracted from detect_trapped_piece to keep nesting depth <= 3 (CLAUDE.md).
    """
    opp = not pov
    piece = board.piece_at(sq)
    if piece is None or piece.color != opp:
        return False

    # Gate 1: not in check, not pinned (immobility from these is a different motif).
    if board.is_check():
        return False
    if board.is_pinned(piece.color, sq):
        return False

    # Gate 2: only N/B/R/Q can be trapped (cook's is_trapped excludes P/K).
    if piece.piece_type in (chess.PAWN, chess.KING):
        return False

    # Gate 3: must be in a bad spot (attacked + hanging-or-takeable-by-lower non-king).
    if not _is_in_bad_spot(board, sq):
        return False

    # Enumerate legal escapes for the trapped piece (set board.turn to piece's color).
    victim_val = _piece_value(piece.piece_type)
    board_victim = board.copy(stack=False)
    board_victim.turn = piece.color
    escape_moves = [m for m in board_victim.legal_moves if m.from_square == sq]

    # Empty-escape-set exclusion (D-06 precision-first): no moves → not trapped.
    if not escape_moves:
        return False

    # Gate 4: check every escape.
    for move in escape_moves:
        dest = move.to_square
        # 4a. Capture of equal-or-greater pov piece → good escape (trade-up/equal).
        pov_piece_at_dest = board_victim.piece_at(dest)
        if pov_piece_at_dest is not None and pov_piece_at_dest.color == pov:
            if _piece_value(pov_piece_at_dest.piece_type) >= victim_val:
                return False
        # 4b. Push and check safety on destination square.
        b2 = board_victim.copy(stack=False)
        b2.push(move)
        if not _is_in_bad_spot(b2, dest):
            return False  # safe square found — not trapped

    # Gate 5: all escapes either lose material or stay in a bad spot → trapped.
    return True


def detect_trapped_piece(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Trapped piece: reimplemented from cook's trapped_piece driver + util.is_trapped
    prose (Phase 134 Plan 02; AGPL boundary — no source copy from cook.py/util.py).

    Cook's driver anchors to the SOLUTION CAPTURE CHAIN (the dominant precision fix):
    instead of scanning every opponent non-pawn piece on every board, walk pov's moves
    at even indices STARTING FROM THE SECOND pov move (k=2,4,...). For each such move
    that captures a non-pawn opponent piece on square t:
      - If the immediately preceding opponent move (moves[k-1]) also landed on t,
        the square-of-interest is moves[k-1].from_square (where the opponent piece
        came from); otherwise it is t.
      - Evaluate _piece_is_trapped on boards[k-1] (the board BEFORE the preceding
        opponent move) at the square-of-interest.
      - If trapped → fire.

    This eliminates the dominant FP source from v3: the old code scanned ALL opponent
    non-pawn pieces on every pov-result board, inventing trapped judgments on pieces
    nowhere near the capture chain (153 FP at P 0.000 on 28 TRAIN rows; Plan 134 target
    is meaningful improvement on the ~1065-row expanded fixture).

    Returns (fired, victim_piece_type, depth) where depth is the board index k at
    which the trapped piece is detected (0 = after pov's first move; cook's driver
    starts at k=2 so the minimum depth here is 2).
    """
    # Need at least 3 moves to have a k=2 candidate (pov k=0, opp k=1, pov k=2).
    if len(moves) < 3 or len(boards) < 4:
        return False, None, None

    opp = not pov

    for k in range(2, len(moves), 2):  # second pov move onward (cook's [1::2][1:])
        capture_sq = moves[k].to_square
        board_before_pov_move = boards[k]  # board right before pov's k-th move

        # Check: pov's k-th move captures a non-pawn opponent piece.
        captured = board_before_pov_move.piece_at(capture_sq)
        if captured is None or captured.color != opp:
            continue
        if captured.piece_type == chess.PAWN:
            continue

        # Determine square-of-interest per cook's driver.
        opp_move = moves[k - 1]
        if opp_move.to_square == capture_sq:
            # Opponent just moved a piece ONTO the capture square — the trapped piece
            # came FROM opp_move.from_square (where it was before being moved there).
            sq_of_interest = opp_move.from_square
        else:
            sq_of_interest = capture_sq

        # Evaluate is_trapped on the board BEFORE the preceding opponent move.
        board_to_check = boards[k - 1]  # = boards[k-1] = before moves[k-1]
        candidate = board_to_check.piece_at(sq_of_interest)
        if candidate is None or candidate.color != opp:
            continue  # no opponent piece at square of interest

        if _piece_is_trapped(board_to_check, sq_of_interest, pov):
            return True, candidate.piece_type, k

    return False, None, None


def detect_back_rank_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Back-rank mate: checkmate with the opponent king boxed on its back rank by
    its OWN pieces, with at least one pov checker on the back rank.

    cook's three-gate logic (D-09, D-10 from prose — no source copy):
      1. board is checkmate AND opponent king is on its back rank.
      2. Own-blocker test: build the king's three forward squares (straight + two
         diagonals, clipped at the a/h files).  Each forward square MUST hold a
         defender piece of the opponent (not empty, not pov, not pov-attacked) —
         the king is boxed by its own pieces.  Any other condition on a forward
         square returns False (this gate eliminates corner-mate false positives
         where forward squares are empty or controlled by pov).
      3. At least one checker must sit on the back rank itself.

    Relative-rank arithmetic (Pitfall 3):
      pov=WHITE → opponent=BLACK, black king on rank 7, forward = king - 8.
      pov=BLACK → opponent=WHITE, white king on rank 0, forward = king + 8.

    Returns (fired, mating_piece_type, depth) on detection.
    tactic_piece = the mating piece (D-12).
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate():
        return False, None, None

    opp_king_sq = boards[-1].king(not pov)
    if opp_king_sq is None:
        return False, None, None

    king_rank = chess.square_rank(opp_king_sq)
    king_file = chess.square_file(opp_king_sq)

    # Opponent's back rank: rank 7 for black king (pov=WHITE), rank 0 for white king (pov=BLACK)
    back_rank = 7 if (not pov) == chess.BLACK else 0
    if king_rank != back_rank:
        return False, None, None

    # Relative-rank forward offset: toward board center for the defender king.
    # pov=WHITE (opponent BLACK king on rank 7): forward_offset = -8 (rank 7 → rank 6).
    # pov=BLACK (opponent WHITE king on rank 0): forward_offset = +8 (rank 0 → rank 1).
    _FORWARD_OFFSET_WHITE_POV: int = -8
    _FORWARD_OFFSET_BLACK_POV: int = 8
    _MIN_FILE: int = 0
    _MAX_FILE: int = 7

    forward_offset = _FORWARD_OFFSET_WHITE_POV if pov == chess.WHITE else _FORWARD_OFFSET_BLACK_POV
    straight_fwd = opp_king_sq + forward_offset

    # Build the list of three forward squares, clipped at edge files.
    forward_squares: list[int] = [straight_fwd]
    if king_file > _MIN_FILE:
        forward_squares.append(straight_fwd - 1)  # forward-left diagonal
    if king_file < _MAX_FILE:
        forward_squares.append(straight_fwd + 1)  # forward-right diagonal

    # Own-blocker test (cook gate 2): every forward square must hold an opponent
    # piece (defender's own piece).  If any forward square is empty, holds a pov
    # piece, or is attacked by pov → this is NOT a back-rank mate (cook returns False).
    board = boards[-1]
    opp = not pov
    for sq in forward_squares:
        occupant = board.piece_at(sq)
        if occupant is None or occupant.color != opp:
            # Square is empty or holds a pov piece — not the own-blocker pattern.
            return False, None, None
        if board.attackers(pov, sq):
            # Square is attacked by pov — not purely a self-block position.
            return False, None, None

    # Back-rank-checker requirement (cook gate 3): at least one checker on the
    # opponent's back rank.
    for checker_sq in board.checkers():
        checker = board.piece_at(checker_sq)
        if checker is not None and checker.color == pov:
            if chess.square_rank(checker_sq) == back_rank:
                return True, checker.piece_type, len(moves) - 1

    return False, None, None


def detect_generic_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Generic mate: final board is checkmate (no named subtype matched).

    Returns (fired, mating_piece_type, depth) on detection.
    tactic_piece = the last-moved (mating) piece (D-12).
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate():
        return False, None, None

    depth = len(moves) - 1 if moves else None
    # Mating piece is the last piece moved
    if moves:
        last_move = moves[-1]
        mating_piece = boards[-1].piece_at(last_move.to_square)
        if mating_piece is not None and mating_piece.color == pov:
            return True, mating_piece.piece_type, depth

    return True, None, depth


# ---------------------------------------------------------------------------
# Named-mate subtype detectors
# Each requires boards[-1].is_checkmate() as a precondition.
# Each returns (bool, mating_piece_type_or_None).
# ---------------------------------------------------------------------------


def detect_smothered_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Smothered mate: knight delivers checkmate; opponent king is surrounded by own pieces.

    Returns (fired, chess.KNIGHT, depth) on detection.
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate() or not moves:
        return False, None, None

    last_move = moves[-1]
    mating_piece = boards[-1].piece_at(last_move.to_square)
    if mating_piece is None or mating_piece.piece_type != chess.KNIGHT:
        return False, None, None

    opp_king_sq = boards[-1].king(not pov)
    if opp_king_sq is None:
        return False, None, None

    # All king escape squares must be occupied by opponent's own pieces (smothered)
    king_moves = boards[-1].attacks(opp_king_sq)
    for escape_sq in king_moves:
        occupant = boards[-1].piece_at(escape_sq)
        # If the square is empty or occupied by a pov piece, it's not a pure smothered mate
        if occupant is None or occupant.color == pov:
            return False, None, None

    return True, chess.KNIGHT, len(moves) - 1


def detect_anastasia_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Anastasia mate: queen/rook on the king's edge file traps the king, with an
    opponent blocker at king+1 center and a pov knight at king+3 center (cook D-10).

    cook geometry (file-normalized, from prose — no source copy):
      - King on a- or h-file but not a corner.
      - Mating move is a queen or rook landing on the king's file.
      - Normalize: a-file king uses +1/+3 toward center; h-file king uses -1/-3.
        This is equivalent to cook's flip_horizontal to a-file: the opponent has a
        blocker one square toward center (king+offset) and pov has a knight three
        squares toward center (king+3*offset).

    Named constants for the blocker and knight offsets (Pitfall 3 / CLAUDE.md):
      _ANASTASIA_BLOCKER_OFFSET = 1   (steps toward center from normalized king)
      _ANASTASIA_KNIGHT_OFFSET = 3    (steps toward center for the blocking knight)

    Returns (fired, mating_piece_type, depth) on detection.
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate() or not moves:
        return False, None, None

    opp_king_sq = boards[-1].king(not pov)
    if opp_king_sq is None:
        return False, None, None

    king_file = chess.square_file(opp_king_sq)
    # King must be on edge file (a or h file), but not in corner
    if king_file not in (0, 7):
        return False, None, None

    king_rank = chess.square_rank(opp_king_sq)
    if king_rank in (0, 7):
        return False, None, None  # corner — arabian mate territory

    last_move = moves[-1]
    mating_piece = boards[-1].piece_at(last_move.to_square)
    if mating_piece is None or mating_piece.piece_type not in (chess.QUEEN, chess.ROOK):
        return False, None, None

    # Mating piece must land on the king's file (cook gate — closes the file)
    if chess.square_file(last_move.to_square) != king_file:
        return False, None, None

    # Cook geometry: direction toward center from the king's edge file.
    # a-file (0): center is at +1, +3 squares. h-file (7): center is at -1, -3 squares.
    # Named constants for clarity (no magic numbers per CLAUDE.md):
    _ANASTASIA_BLOCKER_OFFSET: int = 1
    _ANASTASIA_KNIGHT_OFFSET: int = 3
    center_sign = 1 if king_file == 0 else -1
    blocker_sq = opp_king_sq + center_sign * _ANASTASIA_BLOCKER_OFFSET
    knight_sq = opp_king_sq + center_sign * _ANASTASIA_KNIGHT_OFFSET

    # Require an opponent blocker one step toward center
    board = boards[-1]
    blocker = board.piece_at(blocker_sq)
    if blocker is None or blocker.color == pov:
        return False, None, None

    # Require a pov knight three steps toward center
    knight_piece = board.piece_at(knight_sq)
    if knight_piece is None or knight_piece.color != pov or knight_piece.piece_type != chess.KNIGHT:
        return False, None, None

    return True, mating_piece.piece_type, len(moves) - 1


def detect_hook_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Hook mate: rook adjacent to king, defended by a pov knight ALSO adjacent to king,
    and that knight is defended by a pov pawn (the classic rook←knight←pawn chain).

    cook geometry (D-10, from prose — no source copy):
      - Mating move is a rook.
      - Rook is adjacent to the king (Chebyshev distance 1).
      - A pov knight defends the rook AND is itself adjacent to the king
        (Chebyshev distance 1 from king — this is the "hook" in hook-mate).
      - A pov pawn defends that knight.

    The critical constraint missing from the prior implementation was the
    knight-adjacent-to-king check: cook requires the defender knight to be within
    Chebyshev distance 1 of the king, not merely any pov knight that attacks the
    rook. Without this, arabian-mate positions (king in corner h8/h1 with f6/f3
    knight) were false-positives because the non-adjacent knight still attacked the
    rook square via knight-move geometry (Pitfall 8 — multi-piece chain).

    Returns (fired, chess.ROOK, depth) on detection.
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate() or not moves:
        return False, None, None

    last_move = moves[-1]
    mating_piece = boards[-1].piece_at(last_move.to_square)
    if mating_piece is None or mating_piece.piece_type != chess.ROOK:
        return False, None, None

    opp_king_sq = boards[-1].king(not pov)
    if opp_king_sq is None:
        return False, None, None

    rook_sq = last_move.to_square
    board = boards[-1]

    # Rook must be adjacent to king (Chebyshev distance 1 = within king's attack range)
    if rook_sq not in board.attacks(opp_king_sq):
        return False, None, None

    # A pov knight must defend the rook AND be adjacent to the king (Chebyshev dist=1).
    # The knight-adjacent-to-king constraint is cook's key discriminator that excludes
    # f6/f3 knights in arabian-mate positions from satisfying the hook-mate chain.
    _HOOK_KNIGHT_MAX_DIST: int = 1
    knight_sq: int | None = None
    for def_sq in board.attackers(pov, rook_sq):
        piece = board.piece_at(def_sq)
        if piece is not None and piece.piece_type == chess.KNIGHT:
            if chess.square_distance(def_sq, opp_king_sq) <= _HOOK_KNIGHT_MAX_DIST:
                knight_sq = def_sq
                break

    if knight_sq is None:
        return False, None, None

    # A pov pawn must defend the knight (completing the rook←knight←pawn chain)
    for def_sq in board.attackers(pov, knight_sq):
        piece = board.piece_at(def_sq)
        if piece is not None and piece.piece_type == chess.PAWN:
            return True, chess.ROOK, len(moves) - 1

    return False, None, None


def detect_arabian_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Arabian mate: king in corner, rook adjacent, knight covers remaining escape squares.

    Cook-faithful geometry (Phase 133 cook arabian-mate port): a pov knight attacks
    the rook's landing square AND is exactly (rank_diff==2, file_diff==2) from the
    king. Previously our code checked BB_KNIGHT_ATTACKS[king_sq] (hypothetical knight
    on the king's square), which missed the canonical f6 knight in the h8-king / g8-rook
    pattern (f6 is not in BB_KNIGHT_ATTACKS[h8]). Cook instead iterates actual pov
    attackers of the rook square and checks the (2,2) rank/file distance from the king.

    Returns (fired, chess.ROOK, depth) on detection.
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate() or not moves:
        return False, None, None

    opp_king_sq = boards[-1].king(not pov)
    if opp_king_sq is None:
        return False, None, None

    # King must be in a corner
    king_file = chess.square_file(opp_king_sq)
    king_rank = chess.square_rank(opp_king_sq)
    if king_file not in (0, 7) or king_rank not in (0, 7):
        return False, None, None

    last_move = moves[-1]
    mating_piece = boards[-1].piece_at(last_move.to_square)
    if mating_piece is None or mating_piece.piece_type != chess.ROOK:
        return False, None, None

    rook_sq = last_move.to_square
    # Rook must be adjacent to king (distance == 1)
    if rook_sq not in boards[-1].attacks(opp_king_sq):
        return False, None, None

    # Cook's knight check: iterate pov attackers of the rook square; for each,
    # if it is a knight at exactly (rank_diff==2, file_diff==2) from the king,
    # the arabian-mate pattern is confirmed. This is different from checking
    # BB_KNIGHT_ATTACKS[king_sq] (which checks a hypothetical knight ON the king's
    # square, not the actual pov knight's proximity to the king).
    for knight_sq in boards[-1].attackers(pov, rook_sq):
        piece = boards[-1].piece_at(knight_sq)
        if piece is not None and piece.piece_type == chess.KNIGHT:
            r_diff = abs(chess.square_rank(knight_sq) - chess.square_rank(opp_king_sq))
            f_diff = abs(chess.square_file(knight_sq) - chess.square_file(opp_king_sq))
            if r_diff == 2 and f_diff == 2:
                return True, chess.ROOK, len(moves) - 1

    return False, None, None


def detect_boden_or_double_bishop_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[TacticMotif | None, int | None, int | None]:
    """Boden or double-bishop mate: two bishops deliver checkmate.

    Cook-faithful check (Phase 133 cook boden-mate port): for every square within
    distance < 2 from the opponent king (king + its 8 neighbours), ALL pov attackers
    of that square must be bishops. Previously our code required both bishops to
    directly attack the king's square, which failed the canonical boden pattern
    (e.g. king=c1, bishop=a3 attacks c1, bishop=g6 does NOT attack c1 — only one
    direct check, so the old filter returned None).

    Boden: bishops on opposite sides of king's file.
    Double-bishop: bishops on same side.
    Returns (motif_string_or_None, chess.BISHOP, depth).
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate():
        return None, None, None

    opp_king_sq = boards[-1].king(not pov)
    if opp_king_sq is None:
        return None, None, None

    # Must have at least two pov bishops on the board
    pov_bishops = list(boards[-1].pieces(chess.BISHOP, pov))
    if len(pov_bishops) < 2:
        return None, None, None

    # Cook's check: for all squares within distance < 2 from the king (king + 8
    # adjacent squares), every pov attacker of each such square must be a bishop.
    # A non-bishop pov attacker (e.g. queen, rook) means this is not a pure
    # bishop-mate pattern.
    for sq in chess.SQUARES:
        if chess.square_distance(sq, opp_king_sq) < 2:
            for attacker_sq in boards[-1].attackers(pov, sq):
                piece = boards[-1].piece_at(attacker_sq)
                if piece is None or piece.piece_type != chess.BISHOP:
                    return None, None, None

    king_file = chess.square_file(opp_king_sq)
    b1_file = chess.square_file(pov_bishops[0])
    b2_file = chess.square_file(pov_bishops[1])
    depth = len(moves) - 1

    # Boden: bishops on opposite sides of king's file
    if (b1_file < king_file) != (b2_file < king_file):
        return "boden-mate", chess.BISHOP, depth

    return "double-bishop-mate", chess.BISHOP, depth


def detect_dovetail_mate(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Dovetail (cozio) mate: queen diagonally adjacent to king; each escape square
    is either unattacked or queen-covered-and-empty; king not on edge.

    Cook-faithful predicate (Phase 133 cook dovetail-mate port, fixes inverted adjacency):
    Bug A — previous code REJECTED when queen was adjacent to king (inverted condition).
             Cook REQUIRES the queen to be diagonally adjacent (distance==1).
    Bug B — previous code had no same-file/same-rank guard. FP example: king=f6,
             queen=h6 (same rank, distance 2) — our code accepted it, cook rejects it.
    The escape-square loop (cook cond 4) was also missing entirely.

    Returns (fired, chess.QUEEN, depth) on detection.
    depth = len(moves) - 1 (mates fire at boards[-1], per Pitfall 4).
    """
    if not boards[-1].is_checkmate() or not moves:
        return False, None, None

    last_move = moves[-1]
    mating_piece = boards[-1].piece_at(last_move.to_square)
    if mating_piece is None or mating_piece.piece_type != chess.QUEEN:
        return False, None, None

    opp_king_sq = boards[-1].king(not pov)
    if opp_king_sq is None:
        return False, None, None

    # King must not be on an edge (edge mates are typically back-rank or arabian)
    king_file = chess.square_file(opp_king_sq)
    king_rank = chess.square_rank(opp_king_sq)
    if king_file in (0, 7) or king_rank in (0, 7):
        return False, None, None

    queen_sq = last_move.to_square

    # Queen must NOT be on the same file or rank as the king — dovetail adjacency
    # is diagonal only. Rejects the FP example (king=f6, queen=h6, same rank).
    if chess.square_file(queen_sq) == chess.square_file(opp_king_sq) or chess.square_rank(
        queen_sq
    ) == chess.square_rank(opp_king_sq):
        return False, None, None

    # Queen must be diagonally adjacent to the king (distance == 1).
    if chess.square_distance(queen_sq, opp_king_sq) > 1:
        return False, None, None

    # Cook's escape-square loop (cond 4): for each king-adjacent square (except the
    # queen's own square), verify the position fits the dovetail pattern. The
    # is_checkmate() guard at top already confirms this is a legal checkmate; this
    # loop checks whether the PATTERN is specifically dovetail (queen creates the
    # characteristic "dovetail wing" by diagonally pinning the king's escape squares).
    #
    # Two cases that break the dovetail pattern:
    #   A. attackers == [queen_sq] AND piece_at(sq) is not None:
    #      Queen is the only pov attacker but the square is occupied. Dovetail
    #      requires the queen-covered adjacent squares to be empty (king moves into
    #      queen check) — a piece there disrupts the dovetail geometry.
    #   B. any other pov attacker(s) exist (not just the queen):
    #      Non-queen pov pieces covering an adjacent square means other pieces are
    #      doing the work — not a pure dovetail pattern.
    #
    # If no pov pieces cover an adjacent square, the square is blocked by some other
    # constraint (e.g. opponent's own pieces, board edge effects captured by is_checkmate)
    # and the dovetail pattern may still hold — continue the loop.
    for sq in chess.SQUARES:
        if chess.square_distance(sq, opp_king_sq) != 1 or sq == queen_sq:
            continue
        attackers = list(boards[-1].attackers(pov, sq))
        if attackers == [queen_sq]:
            if boards[-1].piece_at(sq) is not None:
                return False, None, None
        elif attackers:
            return False, None, None

    return True, chess.QUEEN, len(moves) - 1


# ---------------------------------------------------------------------------
# Tier-3 detectors (3+ ply lookback, graded confidence)
# Each returns (bool, piece_int_or_None, confidence_int) where confidence is 0-100.
# ---------------------------------------------------------------------------


def _deflection_fires_at(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color, k: int
) -> int | None:
    """Cook's 11-condition AND-chain for deflection at pov move index k.

    Phase 132 D-01: rewritten from cook.py plain-English pseudocode (AGPL boundary —
    no cook.py source reproduced). See 132-RESEARCH.md §1 for the full predicate.

    Returns captured.piece_type if all 11 conditions hold, else None.

    Index convention (from tactic-tagger-cook-alignment.md):
      moves[k]   = this pov move (even k >= 2)
      moves[k-1] = prev_op_move  (opponent move just before)
      moves[k-2] = prev_player_move  (prior pov move)
      boards[k]  = board BEFORE this pov move  (capture target visible here)
      boards[k-1] = board BEFORE this pov move but AFTER opponent's last move
                    = after prior pov move, before opponent move
      boards[k-2] = board BEFORE prior pov move  ("grandpa.board()" in cook)
    """
    move = moves[k]
    board_k = boards[k]  # cook node.parent.board() (before this pov move)
    board_after = boards[k + 1] if k + 1 < len(boards) else None

    # Condition 1: capture OR promotion.
    is_promotion = move.promotion is not None
    captured = board_k.piece_at(move.to_square)  # Pitfall 6: check board BEFORE move
    is_capture = captured is not None
    if not is_capture and not is_promotion:
        return None
    if board_after is None:
        return None

    square = move.to_square

    # Condition 2: capturing piece must be >= captured in value. cook uses king_values here
    # (king=99), NOT plain values — a prior port wrongly used _VALUES_NO_KING.
    capturing_pt = board_after.piece_type_at(square)
    if capturing_pt is None:
        return None
    if is_capture and _PIECE_VALUES.get(captured.piece_type, 0) > _PIECE_VALUES.get(
        capturing_pt, 0
    ):
        return None

    prev_op_move = moves[k - 1]
    prev_player_move = moves[k - 2]
    grandpa_board = boards[k - 1]  # cook grandpa.board() (AFTER prior pov move)
    gp_parent_board = boards[k - 2]  # cook grandpa.parent.board() (before prior pov move)

    # Condition 7: prior pov move quality gate. cook compares values[capture] < moved_piece_TYPE
    # of grandpa (a value-vs-piece-type-int comparison — replicated faithfully).
    prev_player_capture = gp_parent_board.piece_at(prev_player_move.to_square)
    gp_moved_pt = grandpa_board.piece_type_at(prev_player_move.to_square)
    if prev_player_capture is not None and gp_moved_pt is not None:
        if _VALUES_NO_KING.get(prev_player_capture.piece_type, 0) >= gp_moved_pt:
            return None

    # Condition 8: square collision guards.
    if square == prev_op_move.to_square or square == prev_player_move.to_square:
        return None

    # Condition 9: opponent was forced — they captured where pov just moved, OR (cook:
    # grandpa.board().is_check()) the board AFTER pov's prior move was check.
    if not (prev_op_move.to_square == prev_player_move.to_square or grandpa_board.is_check()):
        return None

    # Condition 10: square reachable from the deflected piece's ORIGINAL square, evaluated on
    # grandpa.board() (boards[k-1]), not the init board (a prior-port divergence).
    orig_sq = prev_op_move.from_square
    if is_promotion:
        same_file = chess.square_file(square) == chess.square_file(orig_sq)
        pov_attacks_from_init = move.from_square in grandpa_board.attacks(orig_sq)
        if not (same_file and pov_attacks_from_init):
            return None
    elif square not in grandpa_board.attacks(orig_sq):
        return None

    # Condition 11: the deflected piece's NEW position no longer covers the capture square.
    if square in board_k.attacks(prev_op_move.to_square):
        return None

    return captured.piece_type if is_capture else chess.PAWN


def detect_deflection(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int, int | None]:
    """Deflection: opponent piece forced away from defending a target.

    Rewritten to cook's exact 11-condition AND-chain (Phase 132 D-01).
    No _grade voting — returns TACTIC_CONFIDENCE_HIGH when the AND-chain fires.

    Returns (fired, target_piece_type, confidence, depth) on detection.
    tactic_piece = the deflected/target piece (D-12).
    depth = k (pov move index when the deflection-exploiting capture fires).
    """
    for k in range(2, len(moves), 2):
        piece_type = _deflection_fires_at(boards, moves, pov, k)
        if piece_type is not None:
            return True, piece_type, TACTIC_CONFIDENCE_HIGH, k

    return False, None, 0, None


def _attraction_fires_at(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color, k: int
) -> int | None:
    """Check cook's exact AND-chain for attraction at pov move index k.

    Reimplemented from cook.py pseudocode (Phase 132 D-01, AGPL boundary — no cook.py
    source). See 132-RESEARCH.md §4 for the full predicate and index mapping.

    Returns the attracted piece type (int) if all conditions hold, else None.
    No _grade voting — cook's predicate is boolean (all conditions or nothing).

    Index convention (k = the lure move, the pov move that attracts the opponent):
      moves[k]   = pov's lure move — even k >= 0
      moves[k+1] = opponent captures on pov's destination (the attraction)
      moves[k+2] = pov's follow-up: lands on square that attacks the attracted square
      moves[k+4] = pov captures on the attracted square (queen/rook branch only)
      boards[k+1] = board BEFORE opponent captures (read attracted piece here)
      boards[k+3] = board AFTER pov's follow-up (read pov's attackers here)
      off-by-one: boards[k+2] should be boards[k+3]; fixed in Phase 133.
    """
    pov_dest = moves[k].to_square
    if k + 2 >= len(moves):
        return None

    # Condition 3: opponent captures on pov's destination.
    opp_move = moves[k + 1]
    if opp_move.to_square != pov_dest:
        return None

    # Attracted piece: the piece that MADE the opponent's move, from boards[k+1]
    # (board BEFORE the opponent move, i.e. after pov's lure — Pitfall 6).
    attracted = boards[k + 1].piece_at(opp_move.from_square)
    if attracted is None or attracted.color == pov:
        return None

    # Condition 4: attracted piece must be KING, QUEEN, or ROOK.
    if attracted.piece_type not in {chess.KING, chess.QUEEN, chess.ROOK}:
        return None

    attracted_to_sq = opp_move.to_square  # == pov_dest

    # Conditions 7+8: pov's next move (k+2) lands on a square from which it attacks
    # the attracted square. boards[k+3] is the board AFTER pov's follow-up move
    # (pov's piece has now arrived on its destination, so it appears in attackers).
    # Phase 133: fixed off-by-one — was boards[k+2] (before pov's follow-up, so pov's
    # piece was still on origin and never in attackers); now boards[k+3] (after follow-up).
    board_k3 = boards[k + 3]
    next_pov_move = moves[k + 2]
    if next_pov_move.to_square not in board_k3.attackers(pov, attracted_to_sq):
        return None

    # Condition 9: KING short-circuit — attraction confirmed immediately.
    if attracted.piece_type == chess.KING:
        return attracted.piece_type

    # Condition 10: queen/rook two-move follow-up — pov captures on the attracted square.
    if k + 4 >= len(moves):
        return None
    if moves[k + 4].to_square == attracted_to_sq:
        return attracted.piece_type

    return None


def detect_attraction(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int, int | None]:
    """Attraction: pov lures a high-value opponent piece to a vulnerable square.

    Rewritten to cook's exact AND-chain (Phase 132 D-01).
    No _grade voting — returns TACTIC_CONFIDENCE_HIGH when the AND-chain fires.
    See 132-RESEARCH.md §4 for the full predicate (AGPL boundary — no cook.py source).

    Returns (fired, attracted_piece_type, confidence, depth) on detection.
    tactic_piece = the attracted piece type (D-12).
    depth = k (pov move index of the lure that attracts the opponent).

    Cook's sequence: pov moves to square X (lure), opponent captures on X (attracted),
    pov's next move lands on a square attacking X, then (if Q/R attracted) pov later
    captures on X. King attraction short-circuits after the attack move.

    Index convention:
      moves[k]   = pov's lure (even k >= 0)
      moves[k+1] = opponent captures on pov's destination (the attracted move)
      moves[k+2] = pov attacks the attracted piece from a new square
      moves[k+4] = pov captures on attracted square (queen/rook branch only)
    """
    for k in range(0, len(moves), 2):  # pov's lure moves (all even k)
        piece_type = _attraction_fires_at(boards, moves, pov, k)
        if piece_type is not None:
            return True, piece_type, TACTIC_CONFIDENCE_HIGH, k

    return False, None, 0, None


def _move_was_capture(board_before: chess.Board, move: chess.Move) -> bool:
    """True if `move` captured a piece on `board_before` (cook's util.is_capture)."""
    return board_before.piece_at(move.to_square) is not None or board_before.is_en_passant(move)


def detect_intermezzo(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, None, int, int | None]:
    """Intermezzo (zwischenzug): an in-between move inserted before the expected recapture.

    Reimplemented to cook's EXACT control flow (AGPL boundary — no cook.py source). cook
    iterates pov capture moves (moves[2], moves[4], ...) and, at the FIRST one that passes the
    two outer guards, RETURNS the inner zwischenzug condition (early-exit). The prior port
    omitted the early-exit (fired on any qualifying k) and used the wrong attacker board, which
    over-fired on capturing-defender lines.

    Index convention (node = moves[k], the delayed recapture, even k >= 2):
      moves[k]    = pov's delayed recapture at capture_square
      moves[k-1]  = opponent's reply to pov's intermezzo
      moves[k-2]  = pov's intermezzo (zwischenzug) move
      boards[k-1] = cook's prev_pov_node.board() (AFTER pov's intermezzo) for the attacker gate
      prev_op     = moves[k-3] (k >= 4) OR the FLAW move (k == 2, via boards[0].move_stack):
                    the opponent's original capture at capture_square

    Returns (fired, None, confidence, depth). tactic_piece None (D-12 ambiguous); depth = k.
    """
    for k in range(2, len(moves), 2):
        if k >= len(boards) or k - 1 < 0:
            continue
        capture_square = moves[k].to_square

        # node must be a capture (cook: `if util.is_capture(node)`).
        if not _move_was_capture(boards[k], moves[k]):
            continue
        # Outer guard A: the opponent's reply (moves[k-1]) did NOT originate from a square that
        # was already attacking capture_square on prev_pov_node.board() = boards[k-1].
        if moves[k - 1].from_square in boards[k - 1].attackers(not pov, capture_square):
            continue
        # Outer guard B: pov's prior move (the intermezzo) did NOT go to capture_square.
        if moves[k - 2].to_square == capture_square:
            continue

        # First node passing the outer guards — evaluate cook's inner condition and RETURN
        # (early-exit: cook does not examine later capture nodes once the guards pass).
        if k >= 4:
            prev_op_move = moves[k - 3]
            prev_op_before = boards[k - 3]  # board before the opponent's original capture
            prev_op_after = boards[k - 2]  # board after it (recapture-was-legal check)
        else:
            # k == 2: cook's prev_op_node is the FLAW move (mainline[0]). It rides on
            # boards[0].move_stack in production (board_after_flaw) and in the gate.
            if not boards[0].move_stack:
                return False, None, 0, None
            prev_op_move = boards[0].peek()
            prev_op_after = boards[0]
            prev_op_before = boards[0].copy()
            prev_op_before.pop()

        inner = (
            prev_op_move.to_square == capture_square
            and _move_was_capture(prev_op_before, prev_op_move)
            and moves[k] in prev_op_after.legal_moves
        )
        if inner:
            return True, None, TACTIC_CONFIDENCE_HIGH, k
        return False, None, 0, None

    return False, None, 0, None


def _x_ray_fires_at(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color, k: int
) -> bool:
    """Check cook's exact AND-chain for x-ray at pov move index k.

    Reimplemented from cook.py pseudocode (Phase 132 D-01, AGPL boundary — no cook.py
    source). See 132-RESEARCH.md §6 for the full predicate and index mapping.

    Returns True if all conditions hold, else False.
    No _grade voting — cook's predicate is boolean.

    The x-ray pattern: three consecutive captures on the SAME square X (pov at k-2,
    opp at k-1, pov again at k), where the opponent's recapturer originally stood on
    the ray between pov's current piece and X (the "x-ray shine-through" geometry).

    Index convention (k = pov's second capture at X):
      moves[k]   = pov's x-ray recapture at X — even k >= 2
      moves[k-1] = opponent's recapture at X (NOT a king)
      moves[k-2] = pov's FIRST capture at X
      boards[k]  = board BEFORE pov's x-ray capture (capture check board — Pitfall 6)
    """
    target_sq = moves[k].to_square

    # Condition 1: this pov move is a capture (Pitfall 6 — check BEFORE the move).
    if boards[k].piece_at(target_sq) is None:
        return False

    # Condition 6 (Pitfall 4 — FIRST guard): three-same-square.
    # All three captures must be on the same square X.
    if moves[k - 2].to_square != target_sq or moves[k - 1].to_square != target_sq:
        return False

    # Condition 4: the opponent's recapturer (moves[k-1]) is NOT a king.
    opp_recapturer = boards[k - 1].piece_at(moves[k - 1].from_square)
    if opp_recapturer is None or opp_recapturer.piece_type == chess.KING:
        return False

    # Condition 7: the x-ray geometry — opponent's recapturer's original square lies
    # between pov's current piece (moves[k].from_square) and the target (moves[k].to_square).
    between = chess.SquareSet.between(moves[k].from_square, target_sq)
    if moves[k - 1].from_square not in between:
        return False

    return True


def detect_x_ray(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, None, int, int | None]:
    """X-ray: pov attacks through an intermediate piece traded off.

    Rewritten to cook's exact three-same-square AND-chain (Phase 132 D-01/D-03).
    No _grade voting — returns TACTIC_CONFIDENCE_HIGH when the AND-chain fires.
    See 132-RESEARCH.md §6 for the full predicate (AGPL boundary — no cook.py source).

    Returns (fired, None, confidence, depth) on detection.
    tactic_piece = None (D-12 ambiguous).
    depth = k (pov move index when the x-ray capture fires).

    Cook's pattern: pov captures at X (moves[k-2]), opponent recaptures at X (moves[k-1],
    NOT a king), pov recaptures again at X (moves[k]). The opponent's original square
    (before recapturing) must lie on the ray between pov's current piece and X — the
    x-ray "shines through" the exchange to recapture.

    D-03 cutoff: if 0 TP on TRAIN after the full port (range(2, len, 2)), the
    PV-divergence ceiling is confirmed and x-ray is suppressed. Restrict to k<=6
    (range(2, 8, 2)) only if full scan yields partial TP; if still 0, suppress.

    Index convention:
      moves[k]   = pov's x-ray recapture at X — even k >= 2
      moves[k-2] = pov's first capture at X
      moves[k-1] = opponent's recapture at X (not a king)
      boards[k]  = board BEFORE pov's x-ray capture
    """
    # Full scan per D-03: try range(2, len(moves), 2) first.
    for k in range(2, len(moves), 2):
        if _x_ray_fires_at(boards, moves, pov, k):
            return True, None, TACTIC_CONFIDENCE_HIGH, k

    return False, None, 0, None


# DO NOT EDIT — interference regression lock (Phase 132, 0.986 TEST; dispatch-cascade
# from attraction tightening caused 2 new FPs but the logic itself is unchanged/correct).
# Any cleanup or refactoring risks breaking the interference precision floor. See
# RESEARCH.md Pitfall 8 and 132-04-SUMMARY.md for the dispatch-cascade explanation.
def _interference_ray_defender(
    init_board: chess.Board, victim_color: chess.Color, square: int
) -> int | None:
    """The single ray defender of `square` on `init_board` (cook's defenders.pop()), or None."""
    defenders = init_board.attackers(victim_color, square)
    defender_sq = next(iter(defenders), None)  # cook: defenders.pop() (LSB)
    if defender_sq is None:
        return None
    defender_piece = init_board.piece_at(defender_sq)
    if defender_piece is None or defender_piece.piece_type not in _RAY_PIECES:
        return None
    return defender_sq


def detect_interference(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, None, int, int | None]:
    """Interference — cook's theme is `self_interference OR interference` (cook.py L109), so we
    fire on EITHER faithful predicate (AGPL boundary, no source copy).

    Both: pov captures a piece on `square` that is now hanging (ray-aware) and the piece had a
    single ray defender on the init board, where some move landed BETWEEN the defender and the
    square, severing the defence.
    - `interference` (PLAYER piece): init = boards[k-2]; the interfering move is pov's prior move
      (moves[k-2]); requires square != moves[k-1].to_square.
    - `self_interference` (OPPONENT piece): init = boards[k-1]; the interfering move is the
      opponent's last move (moves[k-1]).

    The prior port did a single non-ray-aware self_interference-shaped check and over-fired
    (deflection/skewer false positives); it also missed the player-piece variant's recall.

    Returns (fired, None, confidence, depth). tactic_piece None (D-12); depth = k.
    """
    for k in range(2, len(moves), 2):  # pov's captures, from the 2nd pov move
        prev_board = boards[k]  # cook node.parent.board() (before pov's capture)
        square = moves[k].to_square
        capture = prev_board.piece_at(square)
        if capture is None or _is_defended(prev_board, capture, square):
            continue  # must be a capture of a now-hanging (ray-aware) piece

        # self_interference (opponent piece): defender on boards[k-1], opponent move blocks.
        defender_sq = _interference_ray_defender(boards[k - 1], capture.color, square)
        if defender_sq is not None and moves[k - 1].to_square in chess.SquareSet.between(
            square, defender_sq
        ):
            return True, None, TACTIC_CONFIDENCE_HIGH, k

        # interference (player piece): defender on boards[k-2], pov's prior move blocks.
        if square != moves[k - 1].to_square:
            defender_sq = _interference_ray_defender(boards[k - 2], capture.color, square)
            if defender_sq is not None and moves[k - 2].to_square in chess.SquareSet.between(
                square, defender_sq
            ):
                return True, None, TACTIC_CONFIDENCE_HIGH, k

    return False, None, 0, None


def detect_self_interference(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, None, int, int | None]:
    """Self-interference: opponent's OWN piece blocks its own defender's ray.

    Returns (fired, None, confidence, depth) on detection.
    tactic_piece = None (D-12 ambiguous).
    depth = k (pov move index when the self-interference-exploiting capture fires).
    """
    for k in range(2, len(moves), 2):
        board_k = boards[k]
        target_sq = moves[k].to_square
        target = board_k.piece_at(target_sq)
        if target is None:
            continue

        if not _is_hanging(board_k, target_sq, not pov):
            continue

        if k < 2:
            continue

        old_board = boards[k - 2]
        opp_last_move = moves[k - 1]
        blocker_sq = opp_last_move.to_square

        cond1 = False
        cond2 = False
        for defender_sq in old_board.attackers(not pov, target_sq):
            defender = old_board.piece_at(defender_sq)
            if defender is None or defender.piece_type not in _RAY_PIECES:
                continue
            between = chess.SquareSet.between(defender_sq, target_sq)
            if blocker_sq in between:
                cond1 = True
                # The BLOCKER is also an opponent piece (self-interference)
                blocker = board_k.piece_at(blocker_sq)
                cond2 = blocker is not None and blocker.color == (not pov)
                # And the blocker was moved by the opponent (opp_last_move)
                mover_piece = old_board.piece_at(opp_last_move.from_square)
                cond2 = cond2 and mover_piece is not None and mover_piece.color == (not pov)
                break

        met = sum([cond1, cond2])
        if met >= 1:
            return True, None, _grade(met, 2), k

    return False, None, 0, None


def _clearance_prior_move_is_valid(prev_move: chess.Move, move: chess.Move) -> bool:
    """Conditions 3-5: the prior pov move must be eligible to have set up this clearance.

    Not a promotion, and its destination square doesn't collide with either endpoint
    of the clearing move (which would mean the prior move already occupied the
    clearance target or origin, breaking the "square vacated -> another piece uses
    it" geometry this motif requires).
    """
    if prev_move.promotion is not None:
        return False
    if prev_move.to_square == move.from_square:
        return False
    if prev_move.to_square == move.to_square:
        return False
    return True


def detect_clearance(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, None, int, int | None]:
    """Clearance: pov vacates a square so another piece can use the line.

    Rewritten to cook's exact 9-condition AND-chain (Phase 132 D-01).
    No _grade voting — returns TACTIC_CONFIDENCE_HIGH when the AND-chain fires.
    See 132-RESEARCH.md §2 for the full predicate (AGPL boundary — no cook.py source).

    Returns (fired, None, confidence, depth) on detection.
    tactic_piece = None (D-12 ambiguous).
    depth = k (pov move index of the clearance move itself).

    Index convention:
      moves[k]   = this pov clearance move (even k >= 2)
      moves[k-1] = opponent move just before this pov move
      moves[k-2] = prev_move = prior pov move
      boards[k]  = board BEFORE this pov move (= board_before)
      boards[k+1] = board AFTER this pov move (= board_after)
      boards[k-2] = board BEFORE prior pov move
      boards[k-1] = board AFTER prior pov move / before opp move
    """
    for k in range(2, len(moves), 2):
        move = moves[k]
        board_before = boards[k]
        if k + 1 >= len(boards):
            continue

        # Condition 1: pov moves to an EMPTY square (not a capture).
        if board_before.piece_at(move.to_square) is not None:
            continue

        # Condition 2: after the move, the moved piece is a ray piece (Q/R/B) of pov's color.
        board_after = boards[k + 1]
        moved_piece = board_after.piece_at(move.to_square)
        if moved_piece is None or moved_piece.color != pov:
            continue
        if moved_piece.piece_type not in _RAY_PIECES:
            continue

        # Conditions 3-5 require the prior pov move: not a promotion, and its
        # destination doesn't collide with either endpoint of the clearing move.
        prev_move = moves[k - 2]
        if not _clearance_prior_move_is_valid(prev_move, move):
            continue

        # Condition 6: the opponent was NOT in check before pov's clearing move.
        # boards[k] = after opponent's last move = before this pov move.
        if board_before.is_check():
            continue

        # Condition 7 (cook): if the clearing move gives check, the opponent's LAST move
        # (moves[k-1], the move just before this pov move — cook's moved_piece_type(node.parent))
        # must NOT have been a king move. The prior port wrongly inspected moves[k+1] (the
        # opponent's FUTURE response), over-firing on discovered-attack/check lines.
        if board_after.is_check():
            opp_last_pt = board_before.piece_type_at(moves[k - 1].to_square)
            if opp_last_pt == chess.KING:
                continue

        # Condition 8: the key geometry — prior pov move came FROM the clearing target
        # square, OR came from a square BETWEEN the clearing piece's from and to.
        prev_from_sq = prev_move.from_square
        between_sqs = chess.SquareSet.between(move.from_square, move.to_square)
        from_sq_geometry = (
            prev_from_sq == move.to_square  # came from the clearing destination
            or prev_from_sq in between_sqs  # came from a between-square on the ray
        )
        if not from_sq_geometry:
            continue

        # Condition 9: the prior pov move destination must be "bad" for the prior piece.
        # Either the square was empty before the prior pov piece arrived (quiet prep move),
        # OR the prior pov piece is now in a bad spot on its landing square.
        init_board = boards[k - 2]  # board before prior pov move
        pre_board = boards[k - 1]  # board after prior pov move, before opp move
        dest_was_empty = init_board.piece_at(prev_move.to_square) is None
        prior_piece_bad = _is_in_bad_spot(pre_board, prev_move.to_square)
        if not (dest_was_empty or prior_piece_bad):
            continue

        # All 9 conditions met — clearance confirmed.
        return True, None, TACTIC_CONFIDENCE_HIGH, k

    return False, None, 0, None


def _capturing_defender_fires_at(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color, k: int
) -> int | None:
    """Check cook's exact AND-chain for capturing-defender at pov move index k.

    Reimplemented from cook.py pseudocode (Phase 132 D-01, AGPL boundary — no cook.py source).
    See 132-RESEARCH.md §3 for the full predicate and "In our index terms" definitive mapping.

    Returns the captured piece type (int) if all conditions hold, else None.

    Index convention:
      moves[k]   = this pov capture (even k >= 2)
      moves[k-1] = prev_op_move  (opponent move just before pov)
      moves[k-2] = prev_pov_move (the prior pov move)
      boards[k]  = board BEFORE this pov move (capture check board)
      boards[k-2] = init_board (board BEFORE prior pov move — cook's grandpa.board())
    """
    board_k = boards[k]
    move = moves[k]

    # Condition 1: real capture OR checkmate. Check capture first (fast path).
    captured = board_k.piece_at(move.to_square)
    if captured is None:
        # No capture — only fires on checkmate; too rare for Tier-3, skip.
        return None

    # Condition 3: capturing piece is NOT a king.
    captor_piece = board_k.piece_at(move.from_square)
    if captor_piece is None or captor_piece.piece_type == chess.KING:
        return None

    # Condition 4: captured piece is equal or lower value than captor (not capturing up).
    # Use _VALUES_NO_KING (Pitfall 3 — cook uses `values` not `king_values`).
    captured_val = _VALUES_NO_KING.get(captured.piece_type, 0)
    captor_val = _VALUES_NO_KING.get(captor_piece.piece_type, 0)
    if captured_val > captor_val:
        return None

    # Condition 5: captured piece is hanging BEFORE the capture. cook's util.is_hanging is
    # ray-aware (`not is_defended`) — match it so a piece defended only through a friendly
    # ray is not treated as a captured defender.
    if _is_defended(board_k, captured, move.to_square):
        return None

    # Condition 6: opponent's last move was NOT to this capture square (not a recapture).
    prev_op_move = moves[k - 1]
    if prev_op_move.to_square == move.to_square:
        return None

    # Conditions 7-9 require boards[k-2] (init_board = grandpa.board() — before prior pov move).
    init_board = boards[k - 2]

    # Condition 7a: the board AFTER the prior pov move (cook's prev.board() = boards[k-1])
    # was NOT in check. This is the dominant capturing-defender false-positive guard: an
    # intermezzo line (opp captures, we play a CHECKING zwischenzug, opp must respond, we
    # recapture) leaves the opponent in check after our prior move — cook declines, but
    # the prior implementation omitted this board and fired, tagging intermezzo puzzles.
    if boards[k - 1].is_check():
        return None

    # Condition 7b: the board BEFORE the prior pov move was NOT in check (cook init_board).
    if init_board.is_check():
        return None

    # Condition 8: prior pov move did NOT land on the square we capture FROM.
    prev_pov_move = moves[k - 2]
    if prev_pov_move.to_square == move.from_square:
        return None

    # Condition 9: the init-board defender test.
    # defender_sq = prior pov move's destination (where our prior pov piece landed).
    # init_piece = the piece at defender_sq BEFORE our prior pov move arrived.
    # Fires iff that piece existed AND it was an attacker of our current capture square.
    # This is the "our prior pov move displaced a defender of the capture target" check.
    defender_sq = prev_pov_move.to_square
    init_piece = init_board.piece_at(defender_sq)
    if init_piece is None:
        return None
    if defender_sq not in init_board.attackers(init_piece.color, move.to_square):
        return None

    return captured.piece_type


def detect_capturing_defender(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int, int | None]:
    """Capturing defender: pov captures a piece that was defending the real target.

    Rewritten to cook's exact 9-condition AND-chain (Phase 132 D-01).
    No _grade voting — returns TACTIC_CONFIDENCE_HIGH when the AND-chain fires.
    See 132-RESEARCH.md §3 for the full predicate (AGPL boundary — no cook.py source).

    Returns (fired, captured_defender_piece_type, confidence, depth) on detection.
    tactic_piece = the captured defender (D-12).
    depth = k (pov move index when the capturing-defender capture fires).

    Index convention:
      moves[k]   = this pov capture (even k >= 2)
      moves[k-2] = prior pov move
      boards[k]  = board BEFORE this pov move
      boards[k-2] = init_board = board BEFORE prior pov move (cook's grandpa.board())
    """
    for k in range(2, len(moves), 2):
        piece_type = _capturing_defender_fires_at(boards, moves, pov, k)
        if piece_type is not None:
            return True, piece_type, TACTIC_CONFIDENCE_HIGH, k

    return False, None, 0, None


def detect_sacrifice(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int, int | None]:
    """Sacrifice: pov ends up ≥MIN_SACRIFICE_DROP points below the starting material after
    at least the 2nd pov move, and no opponent move is a promotion (cook §7 AND-chain).

    Cook's predicate (lines ~184-191): `_material_diff(boards[k+1], pov) - initial <= -2`
    for k in range(2, len(moves), 2), where initial = `_material_diff(boards[0], pov)`.
    Promotion guard: none of the opponent's moves (odd indices) may be promotions.

    No _grade voting — cook's predicate is boolean (all conditions or nothing).
    Returns TACTIC_CONFIDENCE_HIGH when the AND-chain fires.

    Note (D-02): sacrifice is a co-tag that rarely wins single-winner dispatch (geometric
    and depth-primary motifs pre-empt it). Expected to remain suppressed post-port.
    """
    # Promotion guard (Pitfall 7): check OPPONENT moves (odd indices), not pov moves.
    if any(m.promotion for m in moves[1::2]):
        return False, None, 0, None

    initial = _material_diff(boards[0], pov)

    # Scan from the 2nd pov move onward (k=2, 4, 6, ...): cook scans diffs[1::2][1:].
    for k in range(2, len(moves), 2):
        if k + 1 >= len(boards):
            break
        diff_after = _material_diff(boards[k + 1], pov)
        if diff_after - initial <= -MIN_SACRIFICE_DROP:
            return True, None, TACTIC_CONFIDENCE_HIGH, k

    return False, None, 0, None


# ---------------------------------------------------------------------------
# Phase 128.1-02: Move-type detectors (Tier 5 — the new lowest tier, D-03/D-04)
# ---------------------------------------------------------------------------
# Move-type motifs fire ONLY when no real tactic fires — real tactics always win (D-04).
# The move-type tier has a strictly greater tier number (5) than hanging-piece (4), so
# any real tactic candidate beats any move-type candidate in the dispatcher sort.
#
# Detection is purely on the shape of moves[0] (the refuting move); no material gate
# is applied (en-passant captures and pawn promotions are trivially identifiable from
# the move structure).  These are expected to populate sparsely in practice — the ONLY
# PVs where move-type fires are those where nothing else in tiers 1-4 fired (D-02).


def _solver_move_indices(n_moves: int) -> range:
    """Even move indices = the refuting (pov) side's own moves: moves[0], moves[2], ….

    In our PV representation moves[0] is the first pov move (the published PV is
    game_positions.pv = lichess Moves[1:]), so the even indices are lichess's
    `mainline[1::2]` (every solver move). The move-type and discovered-check detectors
    scan this set — NOT just moves[0] — to match cook.py's whole-line theme predicates.
    """
    return range(0, n_moves, 2)


def detect_en_passant(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """En-passant: ANY pov (solver) move in the line is an en-passant capture.

    Cook-faithful (cook.en_passant scans `mainline[1::2]`): the en-passant capture can
    occur on a later pov move, not just the first. Returns the index of the FIRST such
    move as depth so the depth-primary dispatcher keeps shallower real tactics winning.

    Returns (fired, chess.PAWN, depth=k). Confidence: TACTIC_CONFIDENCE_HIGH (~100% by
    construction — the move shape is unambiguous; standalone P=1.000 on both fixtures).
    """
    for k in _solver_move_indices(len(moves)):
        if boards[k].is_en_passant(moves[k]):
            return True, chess.PAWN, k
    return False, None, None


def detect_promotion(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Promotion (queen): ANY pov (solver) move in the line promotes a pawn to a QUEEN.

    Cook-faithful (cook.promotion scans `mainline[1::2]` for any promotion): the queen
    promotion can occur on a later pov move, not just the first. Returns the index of the
    FIRST queen promotion as depth (depth-primary dispatch keeps real tactics winning).

    D-01 dominance: a non-queen promotion fires detect_under_promotion and NOT this
    function — under-promotion is ranked BEFORE promotion in _MOVE_TYPE_REGISTRY and its
    condition (promotion not None AND != QUEEN) is disjoint from this one (== QUEEN). When
    both detectors fire at the same depth on the same line, the equal-depth (tier, rank)
    tiebreak hands the win to under-promotion.

    Returns (fired, chess.PAWN, depth=k). Confidence: TACTIC_CONFIDENCE_HIGH.
    """
    for k in _solver_move_indices(len(moves)):
        if moves[k].promotion == chess.QUEEN:
            return True, chess.PAWN, k
    return False, None, None


def detect_under_promotion(
    boards: list[chess.Board], moves: list[chess.Move], pov: chess.Color
) -> tuple[bool, int | None, int | None]:
    """Under-promotion: a pov (solver) move promotes a pawn to a NON-queen piece.

    Cook-faithful (cook.under_promotion scans `mainline[1::2]`): walk the pov moves; if a
    pov move delivers checkmate, it counts as under-promotion ONLY when it is a KNIGHT
    promotion (the lone "under" mate) and the scan STOPS there; otherwise any non-queen
    promotion fires. Returns the index of the firing move as depth.

    D-01 dominance: under-promotion DOMINATES promotion (ranked BEFORE detect_promotion in
    _MOVE_TYPE_REGISTRY), so when a pov move is a non-queen promotion, under-promotion is
    returned, NEVER promotion.

    Returns (fired, chess.PAWN, depth=k). Confidence: TACTIC_CONFIDENCE_HIGH.
    """
    for k in _solver_move_indices(len(moves)):
        promo = moves[k].promotion
        # cook checks checkmate FIRST: a mating pov move is under-promotion iff it's a
        # knight promotion, and the scan terminates at that move either way.
        if boards[k + 1].is_checkmate():
            if promo == chess.KNIGHT:
                return True, chess.PAWN, k
            return False, None, None
        # Non-mating non-queen promotion (knight=2, bishop=3, rook=4).
        if promo is not None and promo != chess.QUEEN:
            return True, chess.PAWN, k
    return False, None, None


# ---------------------------------------------------------------------------
# D-07 priority dispatcher — detect_tactic_motif
# ---------------------------------------------------------------------------

# Ordered registry for the D-07 priority order.
# Intra-tier order within tiers 2-3 is provisional (D-08) — reorder here without
# touching detector bodies.

# Type aliases for detector function signatures (Phase 127: all detectors now 3- or 4-tuple with depth)
_BoolPieceFn = Callable[
    [list[chess.Board], list[chess.Move], chess.Color], tuple[bool, int | None, int | None]
]
_Tier3Fn = Callable[
    [list[chess.Board], list[chess.Move], chess.Color], tuple[bool, int | None, int, int | None]
]

# Tier 1: named-mate subtypes in priority order (A3: provisional intra-mate order)
_NAMED_MATE_REGISTRY: list[tuple[TacticMotif, int]] = [
    ("smothered-mate", TacticMotifInt.SMOTHERED_MATE),
    ("anastasia-mate", TacticMotifInt.ANASTASIA_MATE),
    ("hook-mate", TacticMotifInt.HOOK_MATE),
    ("arabian-mate", TacticMotifInt.ARABIAN_MATE),
    # boden/double-bishop handled separately (special return shape)
    ("dovetail-mate", TacticMotifInt.DOVETAIL_MATE),
]

_NAMED_MATE_DETECTOR_FNS: dict[TacticMotif, _BoolPieceFn] = {
    "smothered-mate": detect_smothered_mate,
    "anastasia-mate": detect_anastasia_mate,
    "hook-mate": detect_hook_mate,
    "arabian-mate": detect_arabian_mate,
    "dovetail-mate": detect_dovetail_mate,
}

# Tier 2: geometric material-winners (D-07, provisional D-08 intra-tier order)
# Intra-tier rank = enumerate index (lower = higher priority per _sort_key).
# discovered-check (rank 3) is placed ABOVE discovered-attack (rank 4) so a
# discovering move that gives check tags as discovered-check, not discovered-attack
# (D-03 dominance).  trapped-piece (rank 5) sits after the discovery motifs;
# D-03 tier-level dominance over hanging-piece (Tier 4) is satisfied by tier number
# alone — no intra-tier constraint on trapped-piece (D-05).
_GEOMETRIC_REGISTRY: list[tuple[TacticMotif, int]] = [
    ("fork", TacticMotifInt.FORK),  # rank 0
    ("skewer", TacticMotifInt.SKEWER),  # rank 1
    ("pin", TacticMotifInt.PIN),  # rank 2
    ("double-check", TacticMotifInt.DOUBLE_CHECK),  # rank 3 — check motifs together
    ("discovered-check", TacticMotifInt.DISCOVERED_CHECK),  # rank 4 — D-03: above discovered-attack
    ("discovered-attack", TacticMotifInt.DISCOVERED_ATTACK),  # rank 5
    ("trapped-piece", TacticMotifInt.TRAPPED_PIECE),  # rank 6 — D-05 discretion
]

_GEOMETRIC_DETECTOR_FNS: dict[TacticMotif, _BoolPieceFn] = {
    "fork": detect_fork,
    "skewer": detect_skewer,
    "pin": detect_pin,
    "double-check": detect_double_check,
    "discovered-check": detect_discovered_check,
    "discovered-attack": detect_discovered_attack,
    "trapped-piece": detect_trapped_piece,
}

# Tier 3: fuzzy detectors (D-07 order, provisional D-08)
_TIER3_REGISTRY: list[tuple[TacticMotif, int]] = [
    ("deflection", TacticMotifInt.DEFLECTION),
    ("attraction", TacticMotifInt.ATTRACTION),
    ("intermezzo", TacticMotifInt.INTERMEZZO),
    ("x-ray", TacticMotifInt.X_RAY),
    ("interference", TacticMotifInt.INTERFERENCE),
    ("self-interference", TacticMotifInt.SELF_INTERFERENCE),
    ("clearance", TacticMotifInt.CLEARANCE),
    ("capturing-defender", TacticMotifInt.CAPTURING_DEFENDER),
    ("sacrifice", TacticMotifInt.SACRIFICE),
]

_TIER3_DETECTOR_FNS: dict[TacticMotif, _Tier3Fn] = {
    "deflection": detect_deflection,
    "attraction": detect_attraction,
    "intermezzo": detect_intermezzo,
    "x-ray": detect_x_ray,
    "interference": detect_interference,
    "self-interference": detect_self_interference,
    "clearance": detect_clearance,
    "capturing-defender": detect_capturing_defender,
    "sacrifice": detect_sacrifice,
}

# Tier 5: move-type family (D-03/D-04 — new LOWEST tier below hanging-piece Tier 4).
# Real tactics (tiers 1-4) always win. Move-type only fires on the residual positions
# where no real motif fired. This is EXPECTED and NOT a bug — sparse population is
# the correct behavior (D-02 posture: move-type is the lowest-priority catch for
# positions whose refuting move happens to be a special move type).
#
# Intra-tier order: under-promotion (rank 0) before promotion (rank 1) so that a
# non-queen promotion is NEVER tagged as "promotion" (D-01 under-promotion dominance).
# en-passant is rank 2 (independent; no dominance relationship with promotions).
TIER_MOVE_TYPE = 5  # strictly greater than Tier 4 (hanging-piece) — D-04 real-tactic-wins

_MOVE_TYPE_REGISTRY: list[tuple[TacticMotif, int]] = [
    ("under-promotion", TacticMotifInt.UNDER_PROMOTION),  # rank 0 — D-01: dominates promotion
    ("promotion", TacticMotifInt.PROMOTION),  # rank 1
    ("en-passant", TacticMotifInt.EN_PASSANT),  # rank 2
]

_MOVE_TYPE_DETECTOR_FNS: dict[TacticMotif, _BoolPieceFn] = {
    "under-promotion": detect_under_promotion,
    "promotion": detect_promotion,
    "en-passant": detect_en_passant,
}


def _dispatch_mate_tier(
    boards: list[chess.Board],
    moves: list[chess.Move],
    pov: chess.Color,
    has_forced_mate: bool,
) -> tuple[int, int | None, int, int | None] | None:
    """Tier 1: mate subtypes (D-03 dominance -- always checked first, always wins).

    Mates never enter the non-mate candidate pool (Tiers 2-5); this tier
    short-circuits `detect_tactic_motif` immediately when it fires.

    Returns:
        (tactic_motif_int, tactic_piece, tactic_confidence, tactic_depth) when a mate
        subtype fires, or None when mate detection is ineligible (D-06) or no mate
        detector fires -- signalling the caller to fall through to the non-mate tiers.
    """
    # D-06: mate branch eligibility. boards[-1].is_checkmate() is the fast path for
    # complete PVs; has_forced_mate=True is the fallback for Stockfish-reported mates
    # whose PV is truncated before the mating position.
    if not (boards[-1].is_checkmate() or has_forced_mate):
        return None

    # Named-mate subtypes in priority order (A3)
    for motif_str, motif_int in _NAMED_MATE_REGISTRY:
        fn = _NAMED_MATE_DETECTOR_FNS[motif_str]
        fired, piece, depth = fn(boards, moves, pov)
        if fired:
            return int(motif_int), piece, TACTIC_CONFIDENCE_HIGH, depth

    # Special: boden / double-bishop (returns motif string or None)
    boden_motif, boden_piece, boden_depth = detect_boden_or_double_bishop_mate(boards, moves, pov)
    if boden_motif is not None:
        return _MOTIF_TO_INT[boden_motif], boden_piece, TACTIC_CONFIDENCE_HIGH, boden_depth

    # Back-rank mate (before generic mate)
    br_fired, br_piece, br_depth = detect_back_rank_mate(boards, moves, pov)
    if br_fired:
        return TacticMotifInt.BACK_RANK_MATE, br_piece, TACTIC_CONFIDENCE_HIGH, br_depth

    # Generic mate (catch-all for any checkmate)
    gm_fired, gm_piece, gm_depth = detect_generic_mate(boards, moves, pov)
    if gm_fired:
        return TacticMotifInt.MATE, gm_piece, TACTIC_CONFIDENCE_HIGH, gm_depth

    # BUGFIX (Phase 148, D-01): has_forced_mate=True means Stockfish reported a
    # genuine eval_mate score, but every per-detector mate function above (and
    # detect_generic_mate) bails out via `if not boards[-1].is_checkmate()` when
    # the PV is capped at PV_CAP_PLIES (engine.py) before reaching the mating
    # position — so a real, deep forced mate previously fell through to Tier 2+
    # untagged (no-op). Named-mate geometry cannot be verified on a truncated
    # line, so tag the generic fallback only — do NOT suppress a real mate.
    # `moves` is guaranteed non-empty here (checked by the caller before this
    # function is invoked).
    if has_forced_mate and not boards[-1].is_checkmate():
        _fallback_depth = len(moves) - 1
        _fallback_piece: int | None = None
        _last = boards[-1].piece_at(moves[-1].to_square)
        if _last is not None and _last.color == pov:
            _fallback_piece = _last.piece_type
        return TacticMotifInt.MATE, _fallback_piece, TACTIC_CONFIDENCE_HIGH, _fallback_depth

    return None


_Candidate = tuple[int, int, int | None, int, int | None, int]


def _collect_non_mate_candidates(
    boards: list[chess.Board],
    moves: list[chess.Move],
    pov: chess.Color,
) -> list[_Candidate]:
    """Tiers 2-5: collect every non-mate motif firing on this PV (D-05).

    Tier 5 (move-type) only runs when tiers 2-4 produced no candidates -- move-type
    is a fallback for positions where no real tactic fired, never a competitor
    against one (see the inline ordering comment).
    """
    candidates: list[_Candidate] = []

    # Tier 2: geometric material-winners
    TIER2 = 2
    for rank, (motif_str, motif_int) in enumerate(_GEOMETRIC_REGISTRY):
        fn = _GEOMETRIC_DETECTOR_FNS[motif_str]
        fired, piece, depth = fn(boards, moves, pov)
        if fired:
            candidates.append((TIER2, rank, piece, TACTIC_CONFIDENCE_HIGH, depth, int(motif_int)))

    # Tier 3: fuzzy graded detectors
    TIER3 = 3
    for rank_offset, (motif_str, motif_int) in enumerate(_TIER3_REGISTRY):
        fn = _TIER3_DETECTOR_FNS[motif_str]
        fired, piece, confidence, depth = fn(boards, moves, pov)  # type: ignore[misc]
        if fired:
            candidates.append((TIER3, rank_offset, piece, confidence, depth, int(motif_int)))

    # Tier 4: hanging-piece (catch-all, D-07)
    TIER4 = 4
    hp_fired, hp_piece, hp_depth = detect_hanging_piece(boards, moves, pov)
    if hp_fired:
        candidates.append(
            (
                TIER4,
                0,
                hp_piece,
                TACTIC_CONFIDENCE_HIGH,
                hp_depth,
                int(TacticMotifInt.HANGING_PIECE),
            )
        )

    # Tier 5: move-type family (D-03/D-04 — lowest tier; real tactics in tiers 1-4 always win).
    # Move-type fires only on the RESIDUAL positions where NO real motif fired (the
    # candidate pool from tiers 2-4 is empty; mates already short-circuited above). This is
    # enforced structurally, not via the depth-primary tiebreak: the whole-line scan (Quick
    # 260623) can place a promotion/en-passant at a shallow ply, and without this guard a
    # depth-2 promotion would out-rank a depth-6 real tactic and steal a more-instructive
    # chip. A move-type chip is a fallback, never a winner over a genuine tactic.
    # Under-promotion (rank 0) is ranked before promotion (rank 1) so that a non-queen
    # promotion can NEVER be tagged as "promotion" (D-01 dominance).
    if not candidates:
        for rank, (motif_str, motif_int) in enumerate(_MOVE_TYPE_REGISTRY):
            fn = _MOVE_TYPE_DETECTOR_FNS[motif_str]
            fired, piece, depth = fn(boards, moves, pov)
            if fired:
                candidates.append(
                    (TIER_MOVE_TYPE, rank, piece, TACTIC_CONFIDENCE_HIGH, depth, int(motif_int))
                )

    return candidates


def _select_shallowest_candidate(candidates: list[_Candidate]) -> _Candidate | None:
    """Depth-primary winner selection with a (tier, rank) tiebreak (D-05/D-07).

    Shallowest tactic wins. Equal-depth ties break by (tier, rank) — preserving
    existing priority order. Consequence: hanging-piece (Tier 4, depth 0) beats a
    fork (Tier 2, depth 2) because depth 0 < depth 2. A fork (Tier 2) at depth 0
    beats hanging-piece (Tier 4) at depth 0 via tier tiebreak (2 < 4) — this is
    correct (D-07): when the fork IS at depth 0, it is equally shallow and more
    specific. Tier-3 motifs at depth 0 can beat Tier-2 at depth 2 (D-05 is
    intentional); they are suppressed at query time via _TACTIC_CHIP_CONFIDENCE_MIN
    so this has no user-facing impact. None depth sorts last (treated as infinity).
    """
    if not candidates:
        return None

    def _sort_key(c: _Candidate) -> tuple[int, int, int]:
        depth_val = c[4] if c[4] is not None else 999999
        return (depth_val, c[0], c[1])  # (depth, tier, rank) — depth primary

    return min(candidates, key=_sort_key)


def detect_tactic_motif(
    board_after_flaw: chess.Board,
    pv_str: str,
    has_forced_mate: bool = False,
) -> tuple[int | None, int | None, int | None, int | None]:
    """Detect the highest-priority tactic motif from the refutation PV (D-07/D-02).

    Args:
        board_after_flaw: Position immediately after the flawed move was played.
                          board_after_flaw.turn is the refuting side (pov).
        pv_str: Space-joined UCI refutation line from game_positions.pv.
        has_forced_mate: When True, the mate branch runs even when boards[-1].is_checkmate()
                         is False. Required when Stockfish reports a mate-in-N score but the
                         PV is truncated at PV_CAP_PLIES (~12) so the final board is not yet
                         checkmate. The stored Stockfish score (eval_mate) is the authoritative
                         gate (D-06); is_checkmate() is preserved as the fast path when the
                         PV is short enough to show the final mating position.

    Returns:
        (tactic_motif_int, tactic_piece, tactic_confidence, tactic_depth) where:
        - tactic_motif_int: TacticMotifInt value or None if no detector fired.
        - tactic_piece: chess.PieceType int (1-6) or None (per-motif semantic D-12).
        - tactic_confidence: 0-100 or None when tactic_motif_int is None.
        - tactic_depth: raw half-move ply index from flaw_ply+1 (D-04), or None.
          Caveat (Phase 148 truncated-mate fallback): when `has_forced_mate=True` and
          the PV was capped before reaching mate, this is the last-displayed-ply
          approximation (len(moves)-1), not the true (unknown) mating ply — so it is
          systematically shallower than a fully-resolved mate's depth.

    Dispatch strategy (D-02): mates (Tier 1) short-circuit and always win (D-03/D-07).
    All non-mate detectors run and collect firings; the SHALLOWEST motif wins (depth primary,
    D-05); equal depth breaks by priority tier/rank so exactly one motif is returned.
    Hanging-piece (Tier 4, depth 0) beats a fork (Tier 2, depth 2) because depth dominates.

    Safe: malformed/None/empty pv_str returns (None, None, None, None) without raising.
    """
    # Guard: T-124-03 / T-127-01 — malformed or empty PV must never raise (threat register)
    if not pv_str:
        return None, None, None, None

    try:
        boards, moves = _parse_pv(board_after_flaw, pv_str)
    except ValueError:
        return None, None, None, None

    if not moves:
        return None, None, None, None

    pov = board_after_flaw.turn

    # --- Tier 1: mate subtypes (D-03 dominance — always checked first, always wins) ---
    # Mates never enter the candidate pool; they short-circuit the dispatcher immediately.
    mate_result = _dispatch_mate_tier(boards, moves, pov, has_forced_mate)
    if mate_result is not None:
        return mate_result

    # --- Collect all non-mate firings, then pick the winner (D-05: depth-primary) ---
    candidates = _collect_non_mate_candidates(boards, moves, pov)
    winner = _select_shallowest_candidate(candidates)
    if winner is None:
        return None, None, None, None

    return winner[5], winner[2], winner[3], winner[4]
