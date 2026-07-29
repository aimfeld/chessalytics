"""Library (Games-surface) repository — Phase 106 (SEED-036, LIBG-08/09).

Phase 108 D-02 migration: the window-scan EXISTS flaw filter is replaced by a
direct `game_flaws` table lookup. The shared predicate builder
`build_flaw_filter_clauses` produces the family-aware WHERE clauses (OR within
family, AND across families per SEED-038); `flaw_exists_from_table` wraps them
in a correlated EXISTS for the Games tab. The same predicate builder is reused
by the Flaws SELECT path (Plan 108-05) so cross-tab filter unification is
enforced in code, not convention.

All user input crosses into SQL via bound parameters (user_id, severity, tag
values from `_SEVERITY_INT` / `_TEMPO_INT` dict lookups); no f-string
interpolation of user input (T-108-06).
"""

import datetime
from collections.abc import Sequence
from typing import Any, Literal

import chess
from sqlalchemy import Select, Subquery, and_, case, exists, func, not_, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute, aliased, defer
from sqlalchemy.sql.elements import ColumnElement

from app.models.eval_jobs import EvalJob
from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.repositories.game_flaws_repository import (
    _PHASE_INT,
    _SEVERITY_INT,
    _TEMPO_INT,
)
from app.repositories.query_utils import apply_game_filters, is_opponent_expr, player_only_gate
from app.schemas.library import FlawListItem, TacticLinesResponse
from app.services.best_move_candidates import best_move_tier_sql
from app.services.flaws_service import (
    FlawSeverity,
    FlawTag,
    MATE_LADDER_LOPSIDED_CP,
)
from app.services.normalization import is_correspondence_time_control, parse_base_and_increment
from app.services.openings_service import derive_user_result
from app.services.tactic_detector import (
    TacticMotifInt,
    _INT_TO_MOTIF as _TACTIC_INT_TO_MOTIF,
    _parse_pv,
)

# ---------------------------------------------------------------------------
# Phase 128 Plan 03 (D-07/D-09) — tactic orientation closed enum.
# Phase 129 Plan 01 (D-08) — widened to 3-value Literal; "either" is OR across
# both missed_* and allowed_* column sets.
# Imported by query_utils (lazy import) and library_service so both filter
# sites and the service layer share the same type alias.
# ---------------------------------------------------------------------------
TacticOrientation = Literal["either", "missed", "allowed"]

# ---------------------------------------------------------------------------
# Phase 126 — Tactic chip confidence threshold (TACUI-01, D-09).
# Imported by library_service so the same value gates the comparison repo fn
# (MIN_TACTIC_CHIP_CONFIDENCE in service imports this constant).
# Defined here because query_flaws uses it at the repository layer when building
# FlawListItem rows without going through the service layer.
# ---------------------------------------------------------------------------
_TACTIC_CHIP_CONFIDENCE_MIN: int = 70  # 0-100 scale matching tactic_confidence column

# Domain constants for the tactic depth range (Quick 260621-sm8).
# These mirror DEPTH_MIN / DEPTH_MAX in frontend/src/lib/tacticDepth.ts and are
# used by _tactic_controls_active to detect the "full-range = no depth filter" state.
_TACTIC_DEPTH_FULL_MIN: int = 0
_TACTIC_DEPTH_FULL_MAX: int = 11

# Decision-anchored depth offset for the ALLOWED orientation (Quick 260621-qz9).
# missed_tactic_depth and allowed_tactic_depth both store the RAW 0-based detector
# loop index within their own PV. The missed PV starts at the decision board
# (flaw_ply); the allowed PV is the opponent's refutation, which starts one ply
# LATER (flaw_ply+1). When both depths are measured from the shared pre-flaw
# decision board (as the miniboards and the difficulty filter do), an allowed
# tactic at raw depth d sits one ply deeper than a missed tactic at the same raw
# d. So the allowed column is shifted by +1 at read time to put both orientations
# on one decision-anchored difficulty scale. Mirrors ALLOWED_DECISION_DEPTH_OFFSET
# in frontend/src/lib/tacticDepth.ts. No DB change / backfill (Option A).
ALLOWED_DECISION_DEPTH_OFFSET: int = 1

# ---------------------------------------------------------------------------
# Phase 129 Plan 04 — tactic motif family → int mapping (10-family taxonomy, G-01).
# Maps each family key to the TacticMotifInt values belonging to that family.
# These 10 keys are the cross-stack contract mirrored string-for-string by the
# frontend TacticFamily union (plan 129-05).
#
# Taxonomy decisions (129-UAT RESOLVED DECISIONS):
# - Each Tier-2 real-geometry motif is its own standalone family (no more merged
#   pin_skewer or discovery buckets).
# - The old "combinations" family (DEFLECTION..SACRIFICE, ints 9-17) is dropped
#   entirely — those motif ints belong to no family and are excluded from every
#   family chip/grid/EXISTS expansion. Existing game_flaws rows that carry those
#   ints are unaffected in the DB; they simply stop appearing on family surfaces.
# - The "x_ray" family is standalone (previously merged with pin/skewer).
# - "discovered_check" (int 25) and "trapped_piece" (int 26) are now first-class
#   families. The trapped_piece detector is currently suppressed in the tagger,
#   so that chip will typically be empty — tracked separately, not a bug.
# - "mate" int set is UNCHANGED (ints 7-8, 18-24); _depth_ok reads this key.
# - Move-type motifs: en-passant (27), under-promotion (29), and promotion (28) are
#   now first-class families (unsuppressed at P=1.000 on the expanded fixture — they
#   fire at TACTIC_CONFIDENCE_HIGH=100 so they pass the chip lever). promotion (28) was
#   surfaced when D-09 was reversed (perfect-precision residual, sibling of under-promotion).
#
# No DB migration and no data backfill required: game_flaws stores raw motif INTs
# (SmallInteger); families are a query-time grouping only. Re-mapping family→ints
# re-groups existing rows automatically.
#
# Imported by apply_game_filters() (query_utils.py) via lazy import to avoid
# a query_utils→library_repository circular import.
# ---------------------------------------------------------------------------

FAMILY_TO_MOTIF_INTS: dict[str, list[int]] = {
    "fork": [
        int(TacticMotifInt.FORK),
    ],
    "skewer": [
        int(TacticMotifInt.SKEWER),
    ],
    # pin: cook two-sub-test port achieved 0.819 TEST precision in Phase 131-02.
    # Below the 0.90 ship bar (D-02/D-11); added to SUPPRESSED_MOTIFS in precision_floors.py.
    # Kept in FAMILY_TO_MOTIF_INTS to preserve the 10-family G-01 contract (Plan 04).
    # "Pin" chips will surface in family queries at 0.819 precision until a future phase
    # achieves >0.90 TEST. The tactic_confidence lever cannot suppress confidence=100 Tier-2
    # motifs; removing from this dict would require updating test_family_mapping_ten_families.
    "pin": [
        int(TacticMotifInt.PIN),
    ],
    "x_ray": [
        int(TacticMotifInt.X_RAY),
    ],
    "double_check": [
        int(TacticMotifInt.DOUBLE_CHECK),
    ],
    "discovered_check": [
        int(TacticMotifInt.DISCOVERED_CHECK),
    ],
    "discovered_attack": [
        int(TacticMotifInt.DISCOVERED_ATTACK),
    ],
    "trapped_piece": [
        int(TacticMotifInt.TRAPPED_PIECE),
    ],
    "hanging": [
        int(TacticMotifInt.HANGING_PIECE),
    ],
    "mate": [
        int(TacticMotifInt.BACK_RANK_MATE),
        int(TacticMotifInt.MATE),
        int(TacticMotifInt.SMOTHERED_MATE),
        int(TacticMotifInt.ANASTASIA_MATE),
        int(TacticMotifInt.HOOK_MATE),
        int(TacticMotifInt.ARABIAN_MATE),
        int(TacticMotifInt.BODEN_MATE),
        int(TacticMotifInt.DOUBLE_BISHOP_MATE),
        int(TacticMotifInt.DOVETAIL_MATE),
    ],
    # Tier-3 "Advanced" families (Quick 260623-6pd). Phase 132 cook-aligned AND-chain
    # rewrites lifted these motifs over the 0.90 TEST ship bar; their detectors fire at
    # TACTIC_CONFIDENCE_HIGH (100) so they pass the _TACTIC_CHIP_CONFIDENCE_MIN lever.
    # Surfaced here so they are filterable + counted in the comparison grid, mirroring the
    # frontend "advanced" TACTIC_GROUPS section. Phase 133 added attraction (10) and
    # sacrifice (17) as families; only self-interference (14) remains unmapped.
    "deflection": [
        int(TacticMotifInt.DEFLECTION),
    ],
    "intermezzo": [
        int(TacticMotifInt.INTERMEZZO),
    ],
    "interference": [
        int(TacticMotifInt.INTERFERENCE),
    ],
    "clearance": [
        int(TacticMotifInt.CLEARANCE),
    ],
    "capturing_defender": [
        int(TacticMotifInt.CAPTURING_DEFENDER),
    ],
    # Phase 133 (plan 133-02): attraction and sacrifice unsuppressed and given families.
    # self-interference (14) remains unmapped (no lichess theme equivalent, 0 TP).
    "attraction": [
        int(TacticMotifInt.ATTRACTION),
    ],
    "sacrifice": [
        int(TacticMotifInt.SACRIFICE),
    ],
    # Move-type families (Quick 260623): en-passant + under-promotion + promotion.
    # All fire only at Tier 5 (residual, when no real tactic wins) but at P=1.000 on
    # the expanded fixture. Surfaced behind the "Advanced" filter group. promotion (28)
    # surfaced when D-09 was reversed (perfect-precision, sibling of under-promotion;
    # the "allowed" orientation = "you let the opponent queen" is an instructive endgame
    # mistake). self-interference (14) remains the only unmapped tier-3 int.
    "en_passant": [
        int(TacticMotifInt.EN_PASSANT),
    ],
    "under_promotion": [
        int(TacticMotifInt.UNDER_PROMOTION),
    ],
    "promotion": [
        int(TacticMotifInt.PROMOTION),
    ],
}

# ---------------------------------------------------------------------------
# Phase 128 Plan 03 (D-09) — orientation → (motif_col, confidence_col) resolver.
# Returns the pair of ORM column attributes for the requested orientation.
# Both orientations share FAMILY_TO_MOTIF_INTS and _TACTIC_CHIP_CONFIDENCE_MIN
# unchanged (D-09). The resolved columns are used at both filter sites and the
# chip-read path so the orientation switch is a single conditional, not duplicated
# filter / read logic. orientation is a closed Literal enum — never raw
# column-name interpolation from caller input (T-128-05).
# ---------------------------------------------------------------------------


def _tactic_cols(
    orientation: TacticOrientation,
) -> tuple[Any, Any]:
    """Return (motif_col, confidence_col) ORM attributes for *orientation*.

    allowed → (GameFlaw.allowed_tactic_motif, GameFlaw.allowed_tactic_confidence)
    missed  → (GameFlaw.missed_tactic_motif,  GameFlaw.missed_tactic_confidence)

    Callers pass the result directly to SQLAlchemy filter expressions so the
    column selection is a pure Python branch, never string interpolation.
    Used by fetch_tactic_comparison which iterates over a single orientation.
    """
    if orientation == "missed":
        return GameFlaw.missed_tactic_motif, GameFlaw.missed_tactic_confidence
    return GameFlaw.allowed_tactic_motif, GameFlaw.allowed_tactic_confidence


def _tactic_orientation_pairs(
    orientation: TacticOrientation,
) -> list[tuple[Any, Any, Any, int]]:
    """Return list of (motif_col, conf_col, depth_col, depth_offset) tuples.

    Phase 129 Plan 01 (D-05/D-08): shared resolver for depth-aware + either-aware
    filter sites. Returns:
      "missed"  → [(missed_tactic_motif, missed_tactic_confidence, missed_tactic_depth, 0)]
      "allowed" → [(allowed_tactic_motif, allowed_tactic_confidence, allowed_tactic_depth, +1)]
      "either"  → both tuples (missed first, then allowed)

    Quick 260621-qz9: each tuple carries the decision-anchored depth offset for its
    orientation — 0 for missed, ALLOWED_DECISION_DEPTH_OFFSET for allowed — so the
    depth-range filter compares both orientations on one decision-anchored scale.

    Column selection is a pure Python branch; caller input is a closed Literal
    enum — never string interpolation (T-128-05 / T-129-01).
    """
    missed = (
        GameFlaw.missed_tactic_motif,
        GameFlaw.missed_tactic_confidence,
        GameFlaw.missed_tactic_depth,
        0,
    )
    allowed = (
        GameFlaw.allowed_tactic_motif,
        GameFlaw.allowed_tactic_confidence,
        GameFlaw.allowed_tactic_depth,
        ALLOWED_DECISION_DEPTH_OFFSET,
    )
    if orientation == "missed":
        return [missed]
    if orientation == "allowed":
        return [allowed]
    # "either" — OR across both column sets (D-08)
    return [missed, allowed]


def _depth_in_range(
    depth_col: Any,
    min_tactic_depth: int | None,
    max_tactic_depth: int | None,
    depth_offset: int = 0,
) -> Any:
    """Return a SQLAlchemy boolean clause bounding *depth_col* to an inclusive range.

    Quick 260620-l5k (Phase 130): the depth filter is now a two-handle RANGE in
    depth units (0-based ply, 0..11) instead of a single max cap. Returns:
        (depth_col + offset >= min_tactic_depth) AND (depth_col + offset <= max_tactic_depth)
    with each bound optional (None on a side = unbounded that side; both None =
    literal-true, no filter).

    Quick 260621-qz9: *depth_offset* is the per-orientation decision-anchored
    shift (0 for missed, ALLOWED_DECISION_DEPTH_OFFSET for allowed). The allowed
    column stores the raw 0-based index within the opponent's refutation PV, which
    starts one ply after the shared decision board; adding the offset puts allowed
    and missed depths on the same decision-anchored scale so a range filter treats
    equal-difficulty tactics equally. The column is shifted (not the bounds) so the
    expression reads naturally and a 0 offset compiles to the bare column.

    The Phase 129 D-04 mate exemption was REMOVED here (Quick 260620-l5k, user
    decision "bound mates too"): forced mates now obey the depth range like every
    other tactic, so a narrow range no longer leaks deep mates.
    """
    anchored = depth_col + depth_offset if depth_offset else depth_col
    bounds: list[Any] = []
    if min_tactic_depth is not None:
        bounds.append(anchored >= min_tactic_depth)
    if max_tactic_depth is not None:
        bounds.append(anchored <= max_tactic_depth)
    if not bounds:
        return true()
    return and_(*bounds)


def _tactic_controls_active(
    tactic_families: Sequence[str],
    tactic_orientation: TacticOrientation,
    min_tactic_depth: int | None,
    max_tactic_depth: int | None,
) -> bool:
    """Return True when at least one tactic control departs from the all-inclusive default.

    "All-inclusive default" means: no families selected (no family filter), orientation
    is "either" (both slots in scope), and the depth range covers the full domain
    [_TACTIC_DEPTH_FULL_MIN, _TACTIC_DEPTH_FULL_MAX] (both bounds None or equal to the
    full-range endpoints). When all three controls are at defaults the caller should add
    NO tactic clause so non-tactic flaws are included.

    Quick 260621-sm8: previously depth+orientation predicates were gated inside
    `if tactic_families:`, making them silent no-ops when no family was selected.
    This helper is the single gating predicate so orientation and depth are
    independently meaningful.
    """
    families_active = len(tactic_families) > 0
    orientation_active = tactic_orientation != "either"
    min_active = min_tactic_depth is not None and min_tactic_depth != _TACTIC_DEPTH_FULL_MIN
    max_active = max_tactic_depth is not None and max_tactic_depth != _TACTIC_DEPTH_FULL_MAX
    depth_active = min_active or max_active
    return families_active or orientation_active or depth_active


def tactic_slot_visible(
    motif: int | None,
    confidence: int | None,
    depth: int | None,
    *,
    orientation_kind: Literal["missed", "allowed"],
    tactic_families: Sequence[str],
    tactic_orientation: TacticOrientation,
    min_tactic_depth: int | None,
    max_tactic_depth: int | None,
    decided_lost: bool = False,
) -> bool:
    """Return True iff this tactic slot should be DISPLAYED for the active filter.

    A slot is visible when ALL of the following hold:
    0. The pre-move position was NOT already decisively lost for the mover
       (decided_lost=True → slot is suppressed regardless of all other checks).
       Fail-open: when decided_lost=False (default), this check is skipped.
       The decided_lost bool must stay consistent with the SQL gate in
       build_flaw_filter_clauses (which uses decided_lost_sql). If either is
       changed, update the other.
    1. The slot's orientation_kind is in scope under tactic_orientation
       (missed in scope when orientation is "either" or "missed";
        allowed in scope when orientation is "either" or "allowed").
    2. Confidence is not None and >= _TACTIC_CHIP_CONFIDENCE_MIN.
    3. Motif family: no families selected OR the slot's motif int is in the
       union of FAMILY_TO_MOTIF_INTS for the selected families.
    4. Depth range: full range (= no depth filter) OR (depth + offset) is in
       [min_tactic_depth, max_tactic_depth] (inclusive, using the same +1
       decision-anchored offset as _depth_in_range for the allowed slot).

    Used at BOTH serialization sites (_query_flaws and _build_card) so the
    confidence/family/depth/offset logic is never duplicated. The SQL row
    predicate in build_flaw_filter_clauses must agree with this Python predicate
    on "slot matches" — both rely on the same FAMILY_TO_MOTIF_INTS,
    _TACTIC_CHIP_CONFIDENCE_MIN, ALLOWED_DECISION_DEPTH_OFFSET, and _depth_in_range
    semantics. If either is changed, update the other.

    Args:
        motif: The raw integer motif stored in the DB column (None = no tactic).
        confidence: The raw integer confidence stored in the DB column (None = no tactic).
        depth: The raw 0-based depth stored in the DB column (None = no tactic).
        orientation_kind: "missed" or "allowed" — which slot is being tested.
        tactic_families: Active family filter (empty = no family restriction).
        tactic_orientation: Active orientation filter ("either", "missed", "allowed").
        min_tactic_depth / max_tactic_depth: Inclusive depth-range bounds (None = unbounded).
        decided_lost: True when the pre-move position was already decisively lost for the
                      mover (computed via is_decided_lost). Default False = no suppression.
    """
    # 0. Decided-lost suppression: pre-move position was already lost → tag is absent.
    if decided_lost:
        return False

    # 1. Orientation scope: the slot must be in scope for the requested orientation.
    if orientation_kind == "missed" and tactic_orientation == "allowed":
        return False
    if orientation_kind == "allowed" and tactic_orientation == "missed":
        return False

    # 2. Confidence gate (subsumes the existing confidence >= 70 gate).
    if confidence is None or confidence < _TACTIC_CHIP_CONFIDENCE_MIN:
        return False

    # 3. Family match (skip when no families selected — all motifs pass).
    if tactic_families:
        if motif is None:
            return False
        allowed_ints = {m for fam in tactic_families for m in FAMILY_TO_MOTIF_INTS.get(fam, [])}
        if motif not in allowed_ints:
            return False

    # 4. Depth range (skip when full range is in effect — all depths pass).
    min_active = min_tactic_depth is not None and min_tactic_depth != _TACTIC_DEPTH_FULL_MIN
    max_active = max_tactic_depth is not None and max_tactic_depth != _TACTIC_DEPTH_FULL_MAX
    if min_active or max_active:
        if depth is None:
            return False
        # Apply the same decision-anchored offset as _depth_in_range.
        offset = ALLOWED_DECISION_DEPTH_OFFSET if orientation_kind == "allowed" else 0
        anchored = depth + offset
        if min_tactic_depth is not None and anchored < min_tactic_depth:
            return False
        if max_tactic_depth is not None and anchored > max_tactic_depth:
            return False

    return True


# ---------------------------------------------------------------------------
# Inverse encoding maps — reconstruct tags from game_flaws integer columns
# (D-02 migration: chips built from stored rows, not kernel re-call)
# ---------------------------------------------------------------------------

# int → FlawTag string (reverse of _SEVERITY_INT / _TEMPO_INT / _PHASE_INT).
# Dict comprehensions produce int→str; the ty: ignore[invalid-assignment] on
# each line suppresses the Literal narrowing mismatch (correct at runtime).
_SEVERITY_INT_TO_TAG: dict[int, FlawSeverity] = {  # ty: ignore[invalid-assignment]
    v: k for k, v in _SEVERITY_INT.items()
}
_TEMPO_INT_TO_TAG: dict[int, FlawTag] = {  # ty: ignore[invalid-assignment]
    v: k for k, v in _TEMPO_INT.items()
}
_PHASE_INT_TO_TAG: dict[int, Literal["opening", "middlegame", "endgame"]] = {  # ty: ignore[invalid-assignment]
    v: k for k, v in _PHASE_INT.items()
}


def is_decided_lost(
    eval_cp_before: int | None,
    eval_mate_before: int | None,
    *,
    mover_is_white: bool,
) -> bool:
    """Return True when the pre-move position was already decisively lost for the mover.

    Fail-open: both args None → False (tag is shown / flaw matches filter).
    eval_mate == 0 is not decisive (strict < 0 / > 0 check).

    Must stay consistent with the SQL gate in decided_lost_sql —
    both functions implement the same decided-lost predicate.

    Args:
        eval_cp_before: White-POV centipawn eval at the pre-move position (None = absent).
        eval_mate_before: White-POV mate distance at the pre-move position (None = absent).
        mover_is_white: True when the moving side is White.
    """
    if mover_is_white:
        # White is the mover — White loses when Black has mate (eval_mate < 0) or
        # the position is already lopsidedly losing (eval_cp <= -THRESHOLD).
        if eval_mate_before is not None and eval_mate_before < 0:
            return True
        if eval_cp_before is not None and eval_cp_before <= -MATE_LADDER_LOPSIDED_CP:
            return True
    else:
        # Black is the mover — Black loses when White has mate (eval_mate > 0) or
        # the position is lopsidedly winning for White (eval_cp >= +THRESHOLD).
        if eval_mate_before is not None and eval_mate_before > 0:
            return True
        if eval_cp_before is not None and eval_cp_before >= MATE_LADDER_LOPSIDED_CP:
            return True
    return False


def decided_lost_sql(
    eval_cp_col: Any,
    eval_mate_col: Any,
    user_color_col: Any,
) -> ColumnElement[bool]:
    """Return a NULL-safe SQLAlchemy boolean expression for the decided-lost predicate.

    The expression is always true/false (never SQL NULL) because each disjunct is
    wrapped in a NOT NULL guard — a NULL column simply contributes False, so the
    fail-open rule is structural.

    Mirrors is_decided_lost exactly: white mover loses when eval_mate < 0 OR
    eval_cp <= -MATE_LADDER_LOPSIDED_CP; black mover loses when eval_mate > 0 OR
    eval_cp >= +MATE_LADDER_LOPSIDED_CP. eval_mate == 0 is not decisive (strict signs).

    Must stay consistent with is_decided_lost (the Python counterpart). If either
    is changed, update the other.

    Args:
        eval_cp_col: SQLAlchemy column for white-POV eval_cp (game_positions.eval_cp alias).
        eval_mate_col: SQLAlchemy column for white-POV eval_mate (game_positions.eval_mate alias).
        user_color_col: SQLAlchemy column for game.user_color ("white" | "black").
    """
    white = user_color_col == "white"
    return or_(
        # Mate signal: Black has mate (< 0) for white mover; White has mate (> 0) for black mover.
        and_(
            eval_mate_col.isnot(None),
            or_(
                and_(white, eval_mate_col < 0),
                and_(~white, eval_mate_col > 0),
            ),
        ),
        # CP signal: lopsided loss by centipawn threshold.
        and_(
            eval_cp_col.isnot(None),
            or_(
                and_(white, eval_cp_col <= -MATE_LADDER_LOPSIDED_CP),
                and_(~white, eval_cp_col >= MATE_LADDER_LOPSIDED_CP),
            ),
        ),
    )


def build_flaw_filter_clauses(
    severity: Sequence[FlawSeverity],
    tags: Sequence[FlawTag],
    tactic_families: Sequence[str] = (),
    orientation: TacticOrientation = "either",
    min_tactic_depth: int | None = None,
    max_tactic_depth: int | None = None,
    decided_lost: ColumnElement[bool] | None = None,
) -> list[ColumnElement[bool]]:
    """Return WHERE clauses filtering game_flaws rows (SEED-038 family-aware logic).

    OR within family, AND across families: each returned clause covers one family;
    the caller ANDs all clauses together. Phase tags (opening/middlegame/endgame)
    are a filter family too (Quick 260612-fow) — set-membership on the denormalized
    game_flaws.phase column.

    Encoding maps (_SEVERITY_INT / _TEMPO_INT) are imported from
    game_flaws_repository — single source of truth, no duplication (SEED-038 /
    CLAUDE.md §Shared Query Filters).

    Args:
        severity: Subset of ["mistake", "blunder"]. Set-membership: ["mistake"]
                  matches mistakes only, ["blunder"] matches blunders only, both
                  matches either. Empty = no severity filter (match all severities
                  present in game_flaws).
        tags: Selected FlawTag values from FlawFilterControl. Empty = no tag
              filter. Includes the phase family (opening/middlegame/endgame).
        tactic_families: Tactic motif families to filter on. Empty = no tactic
                  filter. Expands via FAMILY_TO_MOTIF_INTS; unknown keys = no-op.
        orientation: Which tactic column set to filter on (Phase 128/129).
                  "either" (default) → OR across both column sets (Phase 129 D-08).
                    When all controls are at defaults, "either" + empty families + full
                    depth range produces _tactic_controls_active=False and NO clause.
                  "missed"  → missed_tactic_motif  + missed_tactic_confidence.
                  "allowed" → allowed_tactic_motif + allowed_tactic_confidence.
                  FAMILY_TO_MOTIF_INTS and _TACTIC_CHIP_CONFIDENCE_MIN are reused
                  unchanged for all orientations. Orientation is a closed
                  Literal enum — never raw column-name interpolation (T-128-05/T-129-01).
                  Quick 260621-sm8: default changed from "allowed" to "either" so
                  callers that pass no tactic params (e.g. flaw_exists_from_table)
                  still emit no tactic clause.
        min_tactic_depth / max_tactic_depth: Inclusive depth-range bounds (0-based
                  ply) on the active orientation's depth column (Quick 260620-l5k /
                  Phase 130). Each side optional; None = unbounded that side. Mates
                  obey the range too (the Phase 129 D-04 exemption was removed).
        decided_lost: Optional SQL boolean expression (from decided_lost_sql) for
                  the pre-move decided-lost predicate. When non-None, ANDs
                  NOT(decided_lost) onto the assembled tactic clause only — severity,
                  tempo, opportunity, impact, and phase clauses are NOT gated. Callers
                  build this expression via decided_lost_sql and pass it here.
                  None (default) = no suppression (backward-compatible).

    Returns:
        A list of SQLAlchemy column expressions. Empty list = no flaw filter
        (match all rows). The caller is responsible for ANDing the clauses.
    """
    clauses: list[ColumnElement[bool]] = []

    # Severity filter — set membership. The UI exposes Blunders/Mistakes as
    # independent toggles, so ["mistake"] must match mistakes ONLY (not "mistakes or
    # worse"). A prior MIN-threshold (severity >= min) leaked blunders into a
    # mistakes-only selection. game_flaws stores only mistake(1)/blunder(2) (D-03).
    if severity:
        clauses.append(GameFlaw.severity.in_([_SEVERITY_INT[s] for s in severity]))

    # Tempo family: OR within {low-clock, hasty, unrushed}
    tempo_tags = [t for t in tags if t in {"low-clock", "hasty", "unrushed"}]
    if tempo_tags:
        clauses.append(GameFlaw.tempo.in_([_TEMPO_INT[t] for t in tempo_tags]))

    # Opportunity family: OR within {miss, lucky}
    opp_tags = [t for t in tags if t in {"miss", "lucky"}]
    if opp_tags:
        opp_clauses: list[ColumnElement[bool]] = []
        if "miss" in opp_tags:
            opp_clauses.append(GameFlaw.is_miss.is_(True))
        if "lucky" in opp_tags:
            opp_clauses.append(GameFlaw.is_lucky.is_(True))
        clauses.append(or_(*opp_clauses))

    # Impact family: OR within {reversed, squandered}
    imp_tags = [t for t in tags if t in {"reversed", "squandered"}]
    if imp_tags:
        imp_clauses: list[ColumnElement[bool]] = []
        if "reversed" in imp_tags:
            imp_clauses.append(GameFlaw.is_reversed.is_(True))
        if "squandered" in imp_tags:
            imp_clauses.append(GameFlaw.is_squandered.is_(True))
        clauses.append(or_(*imp_clauses))

    # Phase family: OR within {opening, middlegame, endgame}. Each flaw carries
    # exactly one phase (denormalized game_flaws.phase 0/1/2), so set-membership
    # on the typed column is the predicate. Phase filtering is now a first-class
    # filter family (Quick 260612-fow) — superseding the earlier display-only
    # decision (RESEARCH Pitfall 5).
    phase_tags = [t for t in tags if t in {"opening", "middlegame", "endgame"}]
    if phase_tags:
        clauses.append(GameFlaw.phase.in_([_PHASE_INT[t] for t in phase_tags]))

    # Tactic filter (Quick 260621-sm8 refactor): depth and orientation are now
    # independently meaningful even without a family selection.
    #
    # BUG FIXED (260621-sm8): previously depth+orientation predicates were nested
    # inside `if tactic_families:`, making them silent no-ops when no family was
    # selected. The filter claimed to restrict by depth/orientation but did nothing
    # unless a family chip was also active.
    #
    # New logic: when ANY tactic control is active (family, orientation, or depth),
    # emit an OR-of-in-scope-slots row clause. Each in-scope slot (per the
    # orientation parameter) contributes: (family-match, if families selected) AND
    # (confidence >= threshold) AND (depth-in-range, if depth not full-range).
    # When all controls are at defaults (_tactic_controls_active returns False),
    # no tactic clause is emitted so non-tactic flaws are included.
    #
    # The SQL predicate here and tactic_slot_visible (the Python display predicate
    # used at serialization time) must agree: same FAMILY_TO_MOTIF_INTS, same
    # _TACTIC_CHIP_CONFIDENCE_MIN, same _depth_in_range offset semantics.
    # See tactic_slot_visible docstring for the authoritative slot-match definition.
    # Resolve family strings to motif ints first — unknown family keys produce
    # empty lists (they do not contribute to the filter and are silently dropped,
    # per test_unknown_tactic_family_adds_no_clause).
    motif_ints = [m for fam in tactic_families for m in FAMILY_TO_MOTIF_INTS.get(fam, [])]
    # Pass resolved (known) families as the families parameter so unknown-only
    # selections don't trigger a tactic clause when orientation and depth are
    # also at defaults. If orientation or depth are active, the clause is still
    # emitted (orientation/depth work independently — Quick 260621-sm8 fix).
    resolved_families: Sequence[str] = [
        fam for fam in tactic_families if fam in FAMILY_TO_MOTIF_INTS
    ]
    if _tactic_controls_active(resolved_families, orientation, min_tactic_depth, max_tactic_depth):
        # _tactic_orientation_pairs returns 1 tuple for missed/allowed, 2 for either.
        # Each branch: (family-match, if families) & confidence_gate & depth_ok (if active).
        pair_branches = []
        for motif_col, conf_col, depth_col, depth_offset in _tactic_orientation_pairs(orientation):
            branch: ColumnElement[bool] = conf_col >= _TACTIC_CHIP_CONFIDENCE_MIN
            if motif_ints:
                branch = motif_col.in_(motif_ints) & branch
            branch = branch & _depth_in_range(
                depth_col, min_tactic_depth, max_tactic_depth, depth_offset
            )
            pair_branches.append(branch)
        tactic_clause: ColumnElement[bool] = or_(*pair_branches)
        # Decided-lost suppression: exclude flaws from positions already decisively
        # lost for the mover. Only the tactic clause is gated — severity/tempo/
        # opportunity/impact/phase clauses are intentionally NOT gated (flaw still exists).
        if decided_lost is not None:
            tactic_clause = and_(tactic_clause, not_(decided_lost))
        clauses.append(tactic_clause)

    return clauses


def flaw_exists_from_table(
    user_id: int,
    severity: Sequence[FlawSeverity],
    tags: Sequence[FlawTag],
    tactic_families: Sequence[str] = (),
    orientation: TacticOrientation = "either",
    min_tactic_depth: int | None = None,
    max_tactic_depth: int | None = None,
) -> ColumnElement[bool]:
    """Correlated EXISTS: True iff the game has >=1 flaw row satisfying the filter.

    game_flaws-backed EXISTS (replaces the Phase 106 window-scan EXISTS after
    D-02 migration). Scopes to the authenticated user and the outer Game.id so
    cross-user leaks are impossible (T-108-07).

    Returns true() when no filter family is active (severity, tags, AND tactics
    all empty/default) — no filter = match all games. This mirrors the Phase 106
    None sentinel: callers that pass no filter see no restriction added.

    All filter families (severity, context tags, AND tactic motif/orientation/depth)
    are ANDed onto the SAME game_flaws row via build_flaw_filter_clauses. This is the
    single-row AND semantics the Flaws list uses (query_flaws): a game matches only
    when ONE flaw satisfies every selected condition together — e.g. a flaw that is
    BOTH a depth-1-2 fork AND low-clock, not a fork flaw plus a separate low-clock
    flaw (Quick 260621 Games-tab tactic+context AND fix).

    Args:
        user_id: The authenticated user's ID — always included in the EXISTS
                 WHERE clause to prevent cross-user information disclosure.
        severity: Subset of ["mistake", "blunder"]. Empty = no severity filter.
        tags: Selected FlawTag values. Empty = no tag filter.
        tactic_families: Tactic motif families to filter on. Empty = no filter.
        orientation: Which tactic column set to filter on ("either"/"missed"/"allowed").
        min_tactic_depth / max_tactic_depth: Inclusive depth-range bounds on the
                 active orientation's depth column. None = unbounded that side.
    """
    # Decided-lost suppression: LEFT JOIN the pre-move position (ply N-1) inside the
    # EXISTS so the SQL gate has access to eval_cp/eval_mate. LEFT JOIN so ply 0/1
    # flaws (no prior position) keep null eval → fail open (T-bdt-01: join is user-
    # scoped + game-correlated, no cross-user rows can attach).
    # LATERAL rather than a plain outerjoin on `ply == GameFlaw.ply - 1` for the
    # same planner reason as query_flaws — see _flaw_position_lateral. Here the
    # bad shape cost ~7.8s on a Games-tab page load with a tactic filter active
    # (the decided-lost gate is what makes this join live; without it Postgres
    # removes the join entirely, which is why unfiltered loads looked fine).
    PositionBefore = _flaw_position_lateral("pos_before_exists", GameFlaw.ply - 1)  # noqa: N806
    dl = decided_lost_sql(PositionBefore.eval_cp, PositionBefore.eval_mate, Game.user_color)

    clauses = build_flaw_filter_clauses(
        severity,
        tags,
        tactic_families,
        orientation,
        min_tactic_depth,
        max_tactic_depth,
        decided_lost=dl,
    )
    if not clauses:
        # No filter — match all games (caller decides whether to add to statement)
        return true()
    # D-04: player-only gate — after Phase 113 game_flaws contains both sides;
    # the EXISTS filter for the Games tab must only match player flaws so an
    # opponent-only flaw does not falsely flag a game into the Flaw filter (R1/R6).
    # Game.id is the outer correlating column (correlated EXISTS pattern).
    return exists(
        select(GameFlaw.ply)
        .outerjoin(PositionBefore, true())
        .where(
            GameFlaw.game_id == Game.id,
            GameFlaw.user_id == user_id,
            player_only_gate(GameFlaw.ply, Game.user_color),  # D-04 player gate
            *clauses,
        )
    )


def best_move_exists_from_table(tiers: Sequence[Literal["gem", "great"]]) -> ColumnElement[bool]:
    """Correlated EXISTS: True iff the game has >=1 of the USER's OWN plies
    (D-04 player-parity scoping) whose stored game_best_moves candidate row
    classifies into one of `tiers` ('gem'/'great') via the SAME
    best_move_tier_sql/classify_best_move classifier the board consumes
    (D-03b) — board and filter agree by construction, one retune surface.

    game_best_moves has NO user_id column (candidacy is position-scoped, not
    user-scoped — see GameBestMove's model docstring). IDOR safety therefore
    comes ENTIRELY from the `GameBestMove.game_id == Game.id` correlation to
    an already user-scoped outer query (T-175-01) plus player_only_gate
    (D-04a) — never from a user_id filter here, because none exists on this
    table. Callers MUST NOT issue this EXISTS without that outer correlation.

    Mover color for the classifier is always Game.user_color: only rows that
    pass player_only_gate (the mover IS the user) can satisfy the EXISTS, and
    for those rows mover_color_for_ply(ply) always equals Game.user_color by
    construction — there is no separate mover-color column to read.

    Returns true() when `tiers` is empty (mirrors flaw_exists_from_table's
    no-filter sentinel — no filter = match all games).

    Args:
        tiers: Subset of ["gem", "great"] to match (union semantics — a game
               qualifies when ANY selected tier is found on ANY player ply).
               Empty = no filter.
    """
    if not tiers:
        return true()
    # Imported-eval divergence guard (Quick 260717-gmg): correlate the candidate
    # ply's game_positions row (PK game_id+user_id+ply) so best_move_tier_sql can
    # compare our best_cp against lichess's authoritative post-move %eval and drop
    # a spurious badge — the SQL twin of the board's classify_best_move guard, so
    # filter and board stay consistent (D-03b).
    GuardPos = aliased(GamePosition, name="best_move_guard_pos")  # noqa: N806
    tier_expr = best_move_tier_sql(
        GameBestMove.maia_prob,
        GameBestMove.best_cp,
        GameBestMove.best_mate,
        GameBestMove.second_cp,
        GameBestMove.second_mate,
        Game.user_color,
        GuardPos.eval_cp,
        GuardPos.eval_mate,
        Game.lichess_evals_at.isnot(None),
    )
    return exists(
        select(GameBestMove.ply)
        # LEFT join: a candidate ply with no game_positions row leaves the post-move
        # eval NULL, so the guard fails open (badge kept) — mirrors the Python
        # `post_es is None -> keep` path, never dropping a badge over missing data.
        .outerjoin(
            GuardPos,
            and_(
                GuardPos.game_id == GameBestMove.game_id,
                GuardPos.ply == GameBestMove.ply,
                GuardPos.user_id == Game.user_id,
            ),
        )
        .where(
            GameBestMove.game_id == Game.id,
            player_only_gate(GameBestMove.ply, Game.user_color),  # D-04a player gate
            tier_expr.in_(tiers),
        )
    )


def _reconstruct_tags(flaw: GameFlaw) -> list[FlawTag]:
    """Reconstruct FlawTag list from game_flaws typed columns in deterministic order.

    Order: opportunity (miss, lucky) → impact (reversed, squandered)
    → tempo → phase (opening/middlegame/endgame). The Flaws subtab surfaces the
    phase tag in the per-flaw tag list (Quick 260612-fow); the Games-card chips
    are curated separately (`_curate_chips_from_rows`) and still omit phase.

    The deterministic order mirrors _CHIP_ORDER in library_service, with the phase
    tag appended last.

    Args:
        flaw: A GameFlaw ORM row with typed boolean + int columns.

    Returns:
        A list of FlawTag strings in canonical order, phase tag last.
    """
    tags: list[FlawTag] = []
    if flaw.is_miss:
        tags.append("miss")
    if flaw.is_lucky:
        tags.append("lucky")
    if flaw.is_reversed:
        tags.append("reversed")
    if flaw.is_squandered:
        tags.append("squandered")
    if flaw.tempo is not None:
        tempo_tag = _TEMPO_INT_TO_TAG.get(flaw.tempo)
        if tempo_tag is not None:
            tags.append(tempo_tag)
    phase_tag = _PHASE_INT_TO_TAG.get(flaw.phase)
    if phase_tag is not None:
        tags.append(phase_tag)
    return tags


def _compute_move_seconds(
    pos_at: GamePosition | None,
    pos_two_before: GamePosition | None,
    time_control_str: str | None,
) -> float | None:
    """Return time spent on the flawed move in seconds (1dp), or None if unavailable.

    Mirrors flaws_service._move_time (source of truth for the formula): same-side
    clock is two plies back — PositionTwoBefore (ply=N-2), not PositionBefore
    (ply=N-1) which is the opponent's clock (Pitfall 2 in RESEARCH).

    Formula: prev_same_side_clock - clock_after_move + increment
    (increment is added when the move is completed, so clock_after already
    reflects the pre-increment state; we add increment back to recover spent time).

    Returns None when:
    - either position is absent (LEFT JOIN null — ply < 2 or no clock data),
    - either clock_seconds is null (chess.com — no %clk),
    - increment cannot be parsed from time_control_str,
    - computed value is negative (corrupt/inconsistent clock data — WR-05).
    """
    if pos_at is None or pos_two_before is None:
        return None
    prev = pos_two_before.clock_seconds
    curr = pos_at.clock_seconds
    if prev is None or curr is None:
        return None
    _, increment = parse_base_and_increment(time_control_str) if time_control_str else (None, None)
    if increment is None:
        return None
    move_time = prev - curr + increment
    if move_time < 0:
        return None
    return round(move_time, 1)


def _build_flaw_item(
    flaw: GameFlaw,
    game: Game,
    pos_at: GamePosition | None,
    pos_before: GamePosition | None,
    pos_two_before: GamePosition | None,
    *,
    tactic_families: Sequence[str],
    orientation: TacticOrientation,
    min_tactic_depth: int | None,
    max_tactic_depth: int | None,
) -> FlawListItem:
    """Build one FlawListItem from a query_flaws result row.

    Extracted from the query_flaws comprehension to host the per-row
    decided_lost local (computed once, passed to all 6 tactic_slot_visible
    calls) while keeping each helper call readable (CLAUDE.md §keep functions
    shallow; not inlining is_decided_lost six times).

    Quick 260626-bdt: decided_lost is computed from the pre-move position eval
    (pos_before.eval_cp / eval_mate) and the mover color (user_color == "white"
    for player flaws, since all rows are player-gated). When True the tactic tag
    + depth are suppressed (slot returns None) while severity and all other fields
    are unaffected — the flaw still exists and counts.
    """
    row_decided_lost = is_decided_lost(
        pos_before.eval_cp if pos_before else None,
        pos_before.eval_mate if pos_before else None,
        mover_is_white=(game.user_color == "white"),
    )

    # Bug fix: daily (chess.com) and correspondence (lichess) games emit %clk
    # annotations but the values are meaningless — witnessed e.g. for game id 687474
    # (user 28) where clocks jump 0.7s → 21.3s → 1008s → 90s across consecutive
    # moves. Suppress clock_seconds and move_seconds at the display layer so the
    # frontend's != null guards hide the nonsensical numbers. Storage is untouched
    # (game_positions.clock_seconds feeds time-management stats, out of scope).
    is_correspondence = is_correspondence_time_control(game.time_control_str)

    # Tactic slot emission via the shared per-slot display predicate (tactic_slot_visible).
    # A slot is non-null IFF it satisfies the full active filter (orientation ∩ confidence ∩
    # family ∩ depth-range) AND the pre-move position was not already decided-lost.
    # The tactic_slot_visible predicate must agree with the SQL row predicate in
    # build_flaw_filter_clauses. See tactic_slot_visible docstring.
    _tactic_kwargs: dict[str, Any] = dict(
        tactic_families=tactic_families,
        tactic_orientation=orientation,
        min_tactic_depth=min_tactic_depth,
        max_tactic_depth=max_tactic_depth,
        decided_lost=row_decided_lost,
    )
    allowed_visible = tactic_slot_visible(
        flaw.allowed_tactic_motif,
        flaw.allowed_tactic_confidence,
        flaw.allowed_tactic_depth,
        orientation_kind="allowed",
        **_tactic_kwargs,
    )
    missed_visible = tactic_slot_visible(
        flaw.missed_tactic_motif,
        flaw.missed_tactic_confidence,
        flaw.missed_tactic_depth,
        orientation_kind="missed",
        **_tactic_kwargs,
    )
    return FlawListItem(
        game_id=flaw.game_id,
        ply=flaw.ply,
        fen=flaw.fen,
        move_san=pos_at.move_san if pos_at else None,
        severity=_SEVERITY_INT_TO_TAG[flaw.severity],
        tags=_reconstruct_tags(flaw),
        eval_cp_before=pos_before.eval_cp if pos_before else None,
        eval_mate_before=pos_before.eval_mate if pos_before else None,
        eval_cp_after=pos_at.eval_cp if pos_at else None,
        eval_mate_after=pos_at.eval_mate if pos_at else None,
        white_rating=game.white_rating,
        black_rating=game.black_rating,
        user_result=derive_user_result(game.result, game.user_color),
        played_at=game.played_at,
        time_control_bucket=game.time_control_bucket,
        time_control_str=game.time_control_str,
        ply_count=game.ply_count,
        termination=game.termination,
        platform=game.platform,
        platform_url=game.platform_url,
        white_username=game.white_username,
        black_username=game.black_username,
        user_color=game.user_color,
        clock_seconds=(None if is_correspondence else (pos_at.clock_seconds if pos_at else None)),
        move_seconds=(
            None
            if is_correspondence
            else _compute_move_seconds(pos_at, pos_two_before, game.time_control_str)
        ),
        best_move=pos_at.best_move if pos_at else None,
        allowed_tactic_motif=(
            _TACTIC_INT_TO_MOTIF.get(flaw.allowed_tactic_motif)  # ty: ignore[invalid-argument-type]
            if allowed_visible
            else None
        ),
        allowed_tactic_confidence=(flaw.allowed_tactic_confidence if allowed_visible else None),
        allowed_tactic_depth=(flaw.allowed_tactic_depth if allowed_visible else None),
        missed_tactic_motif=(
            _TACTIC_INT_TO_MOTIF.get(flaw.missed_tactic_motif)  # ty: ignore[invalid-argument-type]
            if missed_visible
            else None
        ),
        missed_tactic_confidence=(flaw.missed_tactic_confidence if missed_visible else None),
        missed_tactic_depth=(flaw.missed_tactic_depth if missed_visible else None),
    )


def _flaw_position_lateral(
    name: str, ply_expr: InstrumentedAttribute[int] | ColumnElement[int]
) -> type[GamePosition]:
    """LEFT-JOIN-able LATERAL alias for the game_positions row at `ply_expr`.

    Perf fix (dev Library/Flaws timeout, 2026-07-29): these used to be plain
    `outerjoin(aliased(GamePosition), ...)` with the ply predicate written as
    `alias.ply == GameFlaw.ply - N`. Because `ply - N` is not a plain column
    equality, the planner could not use it as a merge key and fell back to
    `Merge Left Join` on `game_id` alone with the ply test demoted to a Join
    Filter. That degenerates into a per-game cartesian product (every flaw in a
    game x every position in that game), scanning the user's whole
    `game_positions` slice (~200k rows) once per alias — three times over. On a
    user with ~18k flaws the query never finished.

    A LATERAL with `LIMIT 1` cannot be flattened back into a mergeable join, so
    the planner is forced into a nested loop doing one `game_positions_pkey`
    lookup per output row (20 per page instead of 600k). `LIMIT 1` is
    semantically free: (user_id, game_id, ply) is the primary key.
    """
    sub = (
        select(GamePosition)
        .where(
            GamePosition.game_id == GameFlaw.game_id,
            GamePosition.user_id == GameFlaw.user_id,
            GamePosition.ply == ply_expr,
        )
        .limit(1)
        .lateral(name)
    )
    return aliased(GamePosition, sub, name=name)


async def query_flaws(
    session: AsyncSession,
    *,
    user_id: int,
    severity: Sequence[FlawSeverity],
    tags: Sequence[FlawTag],
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None,
    tactic_families: Sequence[str] | None = None,
    orientation: TacticOrientation = "either",
    min_tactic_depth: int | None = None,
    max_tactic_depth: int | None = None,
    offset: int = 0,
    limit: int = 20,
) -> tuple[list[FlawListItem], int]:
    """Paginated SELECT f.* FROM game_flaws JOIN games for the Flaws subtab (Plan 108-05).

    Phase 112 (D-05/D-08): extended with two aliased game_positions outer-joins to
    source move_san, eval_cp/eval_mate before and after the flaw:
      - PositionAt  (alias for ply=N): move_san + eval-after fields
      - PositionBefore (alias for ply=N-1): eval-before fields
    LEFT JOIN ensures no crash when ply=0/1 has no prior position.

    Reuses build_flaw_filter_clauses (shared with the Games EXISTS filter) so
    cross-tab filter unification is enforced in code (SEED-038).

    Ordered recent-first: g.played_at DESC NULLS LAST, f.ply ASC (D-07).
    User-scoped via GameFlaw.user_id == user_id (T-108-10 IDOR mitigation).
    Never exposes *_hash columns (CLAUDE.md V5).

    Args:
        session: AsyncSession for DB access.
        user_id: The authenticated user's ID — always scopes the query (IDOR).
        severity: Severity tiers to include. Empty = no severity filter.
        tags: FlawTag values to filter on (phase tags produce no clause).
        time_control / platform / rated / opponent_type / from_date / to_date /
          color: Game-metadata filters (threaded through apply_game_filters).
        offset: Pagination offset (>= 0).
        limit: Page size (1..100, default 20 per D-08).

    Returns:
        (flaws, matched_count) where matched_count is the total before pagination.
    """
    # Decided-lost SQL expression uses the PositionBefore alias (ply N-1, already
    # LEFT-JOINed below) to access pre-move eval. Built here so it can be passed
    # to both build_flaw_filter_clauses (SQL gate) and the row serialization loop
    # (Python gate via is_decided_lost). Each alias carries its own join predicate
    # inside the LATERAL, so the outerjoin() calls below only need `true()`.
    PositionBefore = _flaw_position_lateral("pos_before", GameFlaw.ply - 1)  # noqa: N806
    PositionTwoBefore = _flaw_position_lateral("pos_two_before", GameFlaw.ply - 2)  # noqa: N806
    dl_sql = decided_lost_sql(PositionBefore.eval_cp, PositionBefore.eval_mate, Game.user_color)

    flaw_clauses = build_flaw_filter_clauses(
        severity,
        tags,
        tactic_families or (),
        orientation,
        min_tactic_depth,
        max_tactic_depth,
        decided_lost=dl_sql,
    )

    # Three aliases for game_positions (Phase 112, D-08; extended 260610-vru):
    # PositionAt:        ply=N   → move_san + eval-after + clock_seconds (mover's remaining clock)
    # PositionBefore:    ply=N-1 → eval-before (position BEFORE the flawed move; also used
    #                              for the decided-lost SQL gate declared above)
    # PositionTwoBefore: ply=N-2 → same-side previous clock for move_seconds computation
    #   (Pitfall 2 from flaws_service._move_time: same-side clock is two plies back, not one)
    # User-scoped on all joins (T-112-02: no cross-user position rows can attach).
    # NOTE: PositionBefore and PositionTwoBefore are declared above (before flaw_clauses)
    # so dl_sql can reference the same alias objects. Only PositionAt is declared here.
    PositionAt = _flaw_position_lateral("pos_at", GameFlaw.ply)  # noqa: N806

    # Base: game_flaws JOIN games + three LATERAL LEFT JOINs on game_positions.
    # The join predicates live inside each lateral (see _flaw_position_lateral),
    # so the ON clause is a constant true.
    #
    # defer(): pgn and the two PV-line JSONB blobs are never read by
    # _build_flaw_item, but they are the widest columns in the row (~23 MB of
    # blobs + ~2 KB of PGN per game for a heavy user). Left in the select list
    # they get detoasted and carried through the ORDER BY sort for every matched
    # flaw, only to be discarded by the LIMIT — which is what pushed this query's
    # sort onto disk once the tier-4 blob backfill populated *_pv_lines.
    base_stmt = (
        select(GameFlaw, Game, PositionAt, PositionBefore, PositionTwoBefore)
        .options(
            defer(GameFlaw.allowed_pv_lines),
            defer(GameFlaw.missed_pv_lines),
            defer(Game.pgn),
        )
        .join(Game, Game.id == GameFlaw.game_id)
        .outerjoin(PositionAt, true())
        .outerjoin(PositionBefore, true())
        .outerjoin(PositionTwoBefore, true())
        .where(
            GameFlaw.user_id == user_id,
            # D-04: player-only gate — after Phase 113 game_flaws contains both sides;
            # the Flaws-subtab list must only show player flaws so opponent blunders do
            # not appear as flaw cards. Game is already joined above (R2 gate).
            player_only_gate(GameFlaw.ply, Game.user_color),
            *flaw_clauses,
        )
    )

    # Apply game-metadata filters (time_control, platform, etc.) via shared util.
    # apply_game_filters adds conditions to a Select[T]; we feed it a select on Game
    # then apply its conditions to base_stmt via a subquery approach.
    # apply_game_filters filters only Game columns — no conflict with GamePosition aliases.
    game_filter_stmt: Select[tuple[int]] = select(Game.id).where(Game.user_id == user_id)
    game_filter_stmt = apply_game_filters(
        game_filter_stmt,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        user_id=user_id,
    )
    base_stmt = base_stmt.where(GameFlaw.game_id.in_(game_filter_stmt))

    # Count total matching rows (before pagination).
    count_stmt = select(func.count()).select_from(base_stmt.subquery())
    matched_count = (await session.execute(count_stmt)).scalar_one()

    if matched_count == 0:
        return [], 0

    # Paginate, ordered recent-first (D-07).
    paged_stmt = (
        base_stmt.order_by(Game.played_at.desc().nulls_last(), GameFlaw.ply.asc())
        .offset(offset)
        .limit(limit)
    )
    rows = (await session.execute(paged_stmt)).all()

    items: list[FlawListItem] = [
        _build_flaw_item(
            flaw,
            game,
            pos_at,
            pos_before,
            pos_two_before,
            tactic_families=tactic_families or (),
            orientation=orientation,
            min_tactic_depth=min_tactic_depth,
            max_tactic_depth=max_tactic_depth,
        )
        for flaw, game, pos_at, pos_before, pos_two_before in rows
    ]
    return items, matched_count


async def fetch_page_game_flaws(
    session: AsyncSession,
    user_id: int,
    game_ids: Sequence[int],
) -> dict[int, list[GameFlaw]]:
    """Batch-load all game_flaws rows for a page of games, grouped by game_id.

    Returns a dict mapping game_id -> list[GameFlaw] (may be empty for an
    analyzed-but-flawless game or a game with no game_flaws rows yet).
    User-scoped via GameFlaw.user_id == user_id (T-108-08 mitigation).

    Single query for the whole page (no N+1 per-game call). The caller groups
    by game_id in Python, reconstructing chips and M+B counts from the rows.
    """
    if not game_ids:
        return {}
    # D-04: player-only gate — after Phase 113 game_flaws contains both sides;
    # fetch_page_game_flaws feeds chip/M+B building on Games-tab cards so it must
    # return only player rows. Game JOIN is added here to bring user_color into
    # scope for player_only_gate (R3 gate).
    stmt = (
        select(GameFlaw)
        .join(Game, Game.id == GameFlaw.game_id)
        .where(
            GameFlaw.user_id == user_id,
            GameFlaw.game_id.in_(game_ids),
            player_only_gate(GameFlaw.ply, Game.user_color),  # D-04 player gate
        )
    )
    rows = list((await session.execute(stmt)).scalars().all())
    result: dict[int, list[GameFlaw]] = {gid: [] for gid in game_ids}
    for row in rows:
        result[row.game_id].append(row)
    return result


async def fetch_page_game_flaws_both_colors(
    session: AsyncSession,
    user_id: int,
    game_ids: Sequence[int],
) -> dict[int, list[GameFlaw]]:
    """Batch-load game_flaws rows for BOTH movers, grouped by game_id.

    WARNING: This ungated both-color variant exists SOLELY to populate eval-chart
    tactic tooltips for opponent plies. It MUST NOT feed severity counts, curated
    chips, the Games-tab EXISTS filter, or any stats — those stay on the
    player-gated fetch_page_game_flaws. See Quick 260628-u7d.

    Identical in shape/return type to fetch_page_game_flaws but omits the
    player_only_gate and the Game JOIN (the JOIN existed only to bring user_color
    into scope for that gate). User-scoped via GameFlaw.user_id == user_id (IDOR).
    """
    if not game_ids:
        return {}
    stmt = select(GameFlaw).where(
        GameFlaw.user_id == user_id,
        GameFlaw.game_id.in_(game_ids),
        # No player_only_gate here — intentionally returns both movers' rows.
    )
    rows = list((await session.execute(stmt)).scalars().all())
    result: dict[int, list[GameFlaw]] = {gid: [] for gid in game_ids}
    for row in rows:
        result[row.game_id].append(row)
    return result


async def fetch_page_eval_positions(
    session: AsyncSession,
    user_id: int,
    game_ids: Sequence[int],
) -> dict[int, list[GamePosition]]:
    """Batch-load GamePosition rows for the given games, grouped by game_id.

    Plain user-scoped id-list fetch — this function has NO analyzed-ness
    predicate of its own (Quick 260714-rj5). Callers decide which game_ids to
    pass: get_library_games still scopes to its analyzed subset (payload-blowup
    guard for the list endpoint), while get_library_game (single-game path) may
    now pass an unanalyzed game_id so an unanalyzed game can still carry its
    move list. Selects full ORM objects so _run_all_moves_pass and _build_tags
    can consume them unchanged. Ordered by game_id, ply ASC for sequential
    grouping. User-scoped via GamePosition.user_id (IDOR mitigation — T-109-01,
    same pattern as fetch_page_game_flaws / T-108-08).
    """
    if not game_ids:
        return {}
    stmt = (
        select(GamePosition)
        .where(
            GamePosition.user_id == user_id,
            GamePosition.game_id.in_(game_ids),
        )
        .order_by(GamePosition.game_id, GamePosition.ply)
    )
    rows = list((await session.execute(stmt)).scalars().all())
    result: dict[int, list[GamePosition]] = {gid: [] for gid in game_ids}
    for row in rows:
        result[row.game_id].append(row)
    return result


async def fetch_page_best_moves(
    session: AsyncSession,
    game_ids: Sequence[int],
) -> dict[int, dict[int, GameBestMove]]:
    """Batch-load GameBestMove candidate rows for the given games, grouped by
    game_id then ply (Phase 175, BOARD-01).

    NO user_id scoping — game_best_moves has no user_id column (candidacy is a
    property of the position, not the user; see app/models/game_best_move.py).
    IDOR safety comes entirely from callers passing an already-user-scoped
    game_ids list — the same list the existing fetch_page_eval_positions callers
    pass (get_library_game's IDOR guard, get_library_games's Game.user_id ==
    user_id filter in query_filtered_games). Never call this with an unscoped
    game_ids list.

    One query for the whole page (no N+1 per-game call), mirroring
    fetch_page_eval_positions's batching shape.
    """
    if not game_ids:
        return {}
    stmt = select(GameBestMove).where(GameBestMove.game_id.in_(game_ids))
    rows = list((await session.execute(stmt)).scalars().all())
    result: dict[int, dict[int, GameBestMove]] = {gid: {} for gid in game_ids}
    for row in rows:
        result[row.game_id][row.ply] = row
    return result


async def fetch_page_analyzed_set(
    session: AsyncSession,
    user_id: int,
    game_ids: Sequence[int],
) -> frozenset[int]:
    """Return the subset of game_ids where full_evals_completed_at IS NOT NULL.

    Used in _build_card to determine analysis_state for each page game without
    a per-game position load. Replaces the per-game count_game_severities
    analysis_state check after D-02 migration. The gate is now the authoritative
    games.full_evals_completed_at column (reversal of the old per-ply coverage
    recompute — see _analyzed_game_ids_subquery docstring).
    """
    if not game_ids:
        return frozenset()
    analyzed_subq = _analyzed_game_ids_subquery(user_id)
    stmt = select(analyzed_subq.c.game_id).where(analyzed_subq.c.game_id.in_(game_ids))
    rows = (await session.execute(stmt)).scalars().all()
    return frozenset(rows)


async def fetch_page_active_eval_status(
    session: AsyncSession,
    user_id: int,
    game_ids: Sequence[int],
) -> dict[int, Literal["pending", "leased"]]:
    """Batch-fetch the active eval-job status (pending|leased) for a page of games.

    Returns a dict mapping game_id -> "pending" | "leased" for games that have an
    active eval_jobs row. Games with no active job (or only completed/failed rows)
    are absent from the result.

    The partial unique index uq_eval_jobs_game_active guarantees at most one active
    (pending or leased) row per game, so the result dict has at most one entry per
    game_id. Mirrors the shape/early-return of fetch_page_analyzed_set.

    Security: game_ids come from the already user-scoped query_filtered_games /
    owner-checked get_library_game — no cross-user game_ids reach this query
    (T-q1x-01 mitigated). The IN-filter restricts to the two active statuses so
    no completed/failed job leaks.

    Args:
        session: AsyncSession for DB access.
        user_id: The authenticated user's ID (used for scoping via game_ids).
        game_ids: Page-level game IDs already scoped to the authenticated user.

    Returns:
        dict mapping game_id to its active eval-job status. Empty when no active jobs.
    """
    if not game_ids:
        return {}
    stmt = select(EvalJob.game_id, EvalJob.status).where(
        EvalJob.game_id.in_(game_ids),
        EvalJob.status.in_(("pending", "leased")),
    )
    rows = (await session.execute(stmt)).all()
    # The IN-filter guarantees only "pending" or "leased" values; cast to the Literal.
    result: dict[int, Literal["pending", "leased"]] = {}
    for game_id, status in rows:
        result[game_id] = status  # IN-filter guarantees only "pending" | "leased"
    return result


async def fetch_stats_aggregates(
    session: AsyncSession,
    user_id: int,
    analyzed_game_ids_subq: Subquery,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    opponent_gap_min: int | None,
    opponent_gap_max: int | None,
    color: str | None,
) -> tuple[int, int, int, int, int, int, int, int, int, int, int, int]:
    """Single game_flaws JOIN games scan producing M+B stats panel aggregates.

    Returns a 12-tuple:
      (mistake_count, blunder_count,
       tempo_low_clock, tempo_hasty, tempo_unrushed,
       is_reversed, is_miss, is_lucky, is_squandered,
       phase_opening, phase_middlegame, phase_endgame)

    All counts are over the analyzed+filtered game set.
    User-scoped (T-108-08). The analyzed_game_ids_subq is now the authoritative
    games.full_evals_completed_at column (reversal of D-03's coverage-subquery
    decision, quick-task 260617-pu4): the old per-ply coverage recompute
    full-scanned the user's game_positions partition on every call, producing
    pathological tail latency (135s avg / 49-min max under an eval-drain in prod).
    full_evals_completed_at is the same formula already materialized by the drain
    and is MORE correct because it rescues short fully-analyzed games that the live
    recompute over-excluded (~0.17% divergence, all in the short-game direction).
    """
    base_filtered_subq = _filtered_games_base(
        user_id,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        flaw_severity=flaw_severity,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        color=color,
    ).subquery("filtered")
    filtered_analyzed_subq = (
        select(base_filtered_subq.c.id)
        .where(base_filtered_subq.c.id.in_(select(analyzed_game_ids_subq.c.game_id)))
        .subquery("filtered_analyzed")
    )

    # D-04: Game JOIN required so Game.user_color is in scope for player_only_gate.
    # After Phase 113 game_flaws contains both sides; this gate ensures the stats
    # panel aggregates count only player flaws (no opponent inflation — R4).
    stmt = (
        select(
            func.count().filter(GameFlaw.severity == _SEVERITY_INT["mistake"]),
            func.count().filter(GameFlaw.severity == _SEVERITY_INT["blunder"]),
            func.count().filter(GameFlaw.tempo == _TEMPO_INT["low-clock"]),
            func.count().filter(GameFlaw.tempo == _TEMPO_INT["hasty"]),
            func.count().filter(GameFlaw.tempo == _TEMPO_INT["unrushed"]),
            func.count().filter(GameFlaw.is_reversed.is_(True)),
            func.count().filter(GameFlaw.is_miss.is_(True)),
            func.count().filter(GameFlaw.is_lucky.is_(True)),
            func.count().filter(GameFlaw.is_squandered.is_(True)),
            func.count().filter(GameFlaw.phase == _PHASE_INT["opening"]),
            func.count().filter(GameFlaw.phase == _PHASE_INT["middlegame"]),
            func.count().filter(GameFlaw.phase == _PHASE_INT["endgame"]),
        )
        .join(Game, Game.id == GameFlaw.game_id)
        .where(
            GameFlaw.user_id == user_id,
            GameFlaw.game_id.in_(select(filtered_analyzed_subq.c.id)),
            player_only_gate(GameFlaw.ply, Game.user_color),  # D-04 player gate (R4)
        )
    )
    row = (await session.execute(stmt)).one()
    return (
        row[0],  # mistake_count
        row[1],  # blunder_count
        row[2],  # tempo_low_clock
        row[3],  # tempo_hasty
        row[4],  # tempo_unrushed
        row[5],  # is_reversed
        row[6],  # is_miss
        row[7],  # is_lucky
        row[8],  # is_squandered
        row[9],  # phase_opening
        row[10],  # phase_middlegame
        row[11],  # phase_endgame
    )


async def fetch_flaw_trend_rows(
    session: AsyncSession,
    user_id: int,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    opponent_gap_min: int | None,
    opponent_gap_max: int | None,
    color: str | None,
) -> list[Any]:
    """Per-game oracle blunder/mistake/inaccuracy counts + ply_count for the trend chart.

    Reads the games-table oracle columns (white_/black_blunders/mistakes/inaccuracies,
    picked by user_color) directly — NOT game_flaws. _compute_flaw_trend turns these
    into per-100-move MACRO rates over a trailing FLAW_TREND_WINDOW-game window, bucketed
    by ISO week. One row per filtered game that has oracle move-quality data
    (oracle-present gate) and a usable played_at + ply_count, ordered played_at ASC.

    The oracle columns are populated from lichess analysis (NULL for chess.com /
    unanalyzed games), so the oracle-present gate is what defines "analyzed" here —
    there is no game_positions eval-coverage join. This is a deliberate divergence from
    the KPI cards (kernel game_flaws for M+B): the trend is an oracle-sourced shape over
    time, so its blunder/mistake lines will not tie out exactly with the KPI cards.
    """
    base_filtered_subq = _filtered_games_base(
        user_id,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        flaw_severity=flaw_severity,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        color=color,
    ).subquery("filtered_t")

    is_white = Game.user_color == "white"
    blunders = case((is_white, Game.white_blunders), else_=Game.black_blunders)
    mistakes = case((is_white, Game.white_mistakes), else_=Game.black_mistakes)
    inaccuracies = case((is_white, Game.white_inaccuracies), else_=Game.black_inaccuracies)

    stmt = (
        select(
            Game.played_at,
            Game.user_color,
            Game.ply_count,
            blunders.label("blunders"),
            mistakes.label("mistakes"),
            inaccuracies.label("inaccuracies"),
        )
        .where(
            Game.user_id == user_id,
            Game.id.in_(select(base_filtered_subq.c.id)),
            Game.played_at.isnot(None),
            Game.ply_count.isnot(None),
            Game.ply_count > 0,
            # Oracle-present gate: the user's-color move-quality columns are non-null.
            or_(
                (Game.user_color == "white") & Game.white_blunders.isnot(None),
                (Game.user_color == "black") & Game.black_blunders.isnot(None),
            ),
        )
        .order_by(Game.played_at.asc())
    )
    rows = (await session.execute(stmt)).all()
    return list(rows)


async def fetch_stats_per_game_rates(
    session: AsyncSession,
    user_id: int,
    analyzed_game_ids_subq: Subquery,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    opponent_gap_min: int | None,
    opponent_gap_max: int | None,
    color: str | None,
) -> list[Any]:
    """Per-game player M/B counts + oracle inaccuracy for the macro per-100 stats rates.

    One row per analyzed+filtered game: (user_moves, player_mistake, player_blunder,
    player_inaccuracy). The service averages count/user_moves*100 across games (MACRO,
    each game weighted equally) so the card's blunder/mistake per-100 equal the
    you-vs-opponent bullet's player_rate EXACTLY — same anchor, same player_only_gate,
    same floor/ceil(ply_count/2) denominator as fetch_flaw_comparison.

    Inaccuracy comes from the oracle columns (games.white_/black_inaccuracies, D-03):
    game_flaws never stores inaccuracies, so inaccuracy has no game_flaws/bullet
    counterpart and stands alone (NULL oracle -> 0, mirroring _build_game_flaw_card).
    Today those columns are lichess-only (NULL for chess.com / unanalyzed); they
    self-populate once chess.com full-game Stockfish analysis lands.

    LEFT JOIN game_flaws so zero-flaw analyzed games still contribute a 0-rate row.
    Anchor excludes ply_count NULL/0 (divide-by-zero guard, Pitfall 2). Use
    func.count(GameFlaw.ply) NOT func.count() so absent LEFT-JOIN rows count as 0.
    """
    base_filtered_subq = _filtered_games_base(
        user_id,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        flaw_severity=flaw_severity,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        color=color,
    ).subquery("filtered_pgr")

    # Anchor: analyzed+filtered games with valid ply_count. user_moves and the oracle
    # inaccuracy pick are Game-only expressions, carried into the GROUP BY below.
    anchor_subq = (
        select(
            Game.id.label("game_id"),
            Game.user_color,
            case(
                (Game.user_color == "white", func.floor(Game.ply_count / 2.0)),
                else_=func.ceil(Game.ply_count / 2.0),
            ).label("user_moves"),
            case(
                (Game.user_color == "white", Game.white_inaccuracies),
                else_=Game.black_inaccuracies,
            ).label("player_inaccuracy"),
        )
        .where(
            Game.user_id == user_id,
            Game.id.in_(select(base_filtered_subq.c.id)),
            Game.id.in_(select(analyzed_game_ids_subq.c.game_id)),
            Game.ply_count.isnot(None),
            Game.ply_count > 0,
        )
        .subquery("anchor_pgr")
    )

    stmt = (
        select(
            anchor_subq.c.user_moves,
            anchor_subq.c.player_inaccuracy,
            func.count(GameFlaw.ply)
            .filter(
                player_only_gate(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity == _SEVERITY_INT["mistake"],
            )
            .label("player_mistake"),
            func.count(GameFlaw.ply)
            .filter(
                player_only_gate(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity == _SEVERITY_INT["blunder"],
            )
            .label("player_blunder"),
        )
        .outerjoin(
            GameFlaw,
            (GameFlaw.game_id == anchor_subq.c.game_id) & (GameFlaw.user_id == user_id),
        )
        .group_by(
            anchor_subq.c.game_id,
            anchor_subq.c.user_moves,
            anchor_subq.c.player_inaccuracy,
        )
    )
    rows = (await session.execute(stmt)).all()
    return list(rows)


def _filtered_games_base(
    user_id: int,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    opponent_gap_min: int | None,
    opponent_gap_max: int | None,
    color: str | None = None,
    tactic_families: Sequence[str] | None = None,
    # Quick 260621-sm8 follow-up: neutral default "either" (was "allowed"). The
    # tactic EXISTS is now gated on _tactic_controls_active (orientation alone can
    # activate it), so an "allowed" default would make count_filtered_and_analyzed
    # wrongly filter the coverage/comparison denominators when no tactic filter is
    # set. No caller relies on the old "allowed" default (all family-narrowing
    # callers pass orientation explicitly).
    tactic_orientation: TacticOrientation = "either",
) -> Select[tuple[int]]:
    """Build the filtered `SELECT Game.id` base shared by the archive + stats paths.

    The single place the Games-surface filter set (incl. the boolean
    flaw-severity EXISTS) is composed, so query_filtered_games,
    count_filtered_and_analyzed, and analyzed_game_ids stay in lockstep on what
    "the filtered set" means. user_id is threaded into both the base WHERE and
    the EXISTS scope (T-106-02AC / T-106-03AC).

    Phase 126 (D-06): tactic_families narrows to games containing a tactic flaw
    in one of the selected families (routed through apply_game_filters).

    SEED-062: tactic_orientation selects which column set the tactic_families
    narrowing matches on (default "allowed"). The tactic-comparison endpoint
    passes "either" so the population includes games whose only family-X tactic
    was missed-only, matching its dual-orientation grid.
    """
    base_stmt: Select[tuple[int]] = select(Game.id).where(Game.user_id == user_id)
    return apply_game_filters(
        base_stmt,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        flaw_severity=flaw_severity,
        tactic_families=tactic_families,
        orientation=tactic_orientation,
        user_id=user_id,
    )


async def query_filtered_games(
    session: AsyncSession,
    user_id: int,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    flaw_tags: Sequence[str] | None = None,
    tactic_families: Sequence[str] | None = None,
    tactic_orientation: TacticOrientation = "either",
    min_tactic_depth: int | None = None,
    max_tactic_depth: int | None = None,
    offset: int,
    limit: int,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
    color: str | None = None,
    has_gem: bool | None = None,
    has_great: bool | None = None,
) -> tuple[list[Game], int]:
    """Return paginated user Game objects, optionally flaw-severity/tag/tactic filtered.

    Mirrors endgame_repository.query_endgame_games' paginated-archive shape, but
    drops the endgame-span subquery — the base select is simply the user's games,
    with the flaw EXISTS applied via apply_game_filters when severities and/or
    tags are supplied (LIBG-08, SEED-038). flaw_tags restricts to games with a
    single flaw satisfying ALL selected tag families (OR within family, AND
    across families). tactic_families (Quick 260620-pza) restricts to games with
    ≥1 flaw whose tactic motif (in the orientation's column, within the depth
    range) is in the selected families — the same tactic EXISTS the Flaws tab
    uses, just threaded to the Games tab. has_gem / has_great (FILT-01) restrict
    to games with >=1 of the user's OWN plies classifying as that tier via the
    SAME classifier the board uses (D-04/D-05a) — union semantics when both are
    set. When all of flaw_severity / flaw_tags / tactic_families / has_gem /
    has_great are None/empty/False the query is a plain filtered archive (no EXISTS).

    Returns (page_games, matched_count) where matched_count reflects ALL matching
    games before offset/limit. Ordered played_at DESC nulls last. The user_id is
    threaded into both the base WHERE and the EXISTS scope (T-106-02AC).
    """
    base_stmt = select(Game).where(Game.user_id == user_id)
    base_stmt = apply_game_filters(
        base_stmt,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        flaw_severity=flaw_severity,
        flaw_tags=flaw_tags,
        tactic_families=tactic_families,
        orientation=tactic_orientation,
        min_tactic_depth=min_tactic_depth,
        max_tactic_depth=max_tactic_depth,
        user_id=user_id,
        has_gem=has_gem,
        has_great=has_great,
    )

    # Count total matching games (before pagination).
    count_stmt = select(func.count()).select_from(base_stmt.subquery())
    matched_count = (await session.execute(count_stmt)).scalar_one()

    if matched_count == 0:
        return [], 0

    games_stmt = base_stmt.order_by(Game.played_at.desc().nulls_last()).offset(offset).limit(limit)
    games = list((await session.execute(games_stmt)).scalars().all())
    return games, matched_count


def _analyzed_game_ids_subquery(user_id: int) -> Subquery:
    """Indexed games-table lookup: game_ids where full_evals_completed_at IS NOT NULL.

    REVERSAL (quick-task 260617-pu4): the previous implementation was a per-game
    coverage aggregate over game_positions (SUM(has_eval) / (COUNT(*)-1) >=
    EVAL_COVERAGE_MIN, grouped by game_id). That GROUP BY / HAVING full-scanned the
    user's entire game_positions partition on every call — 409k rows for the largest
    prod user — causing 135s avg / 49-min max fetch_stats_aggregates latency under an
    eval-drain (prod finding 2026-06-17).

    That coverage formula was already materialized by the eval-drain into
    games.full_evals_completed_at, so we can replace the cold-page partition scan with
    a single indexed games lookup. This is strictly cheaper (PK index, no aggregate)
    and also MORE correct: the per-ply recompute (COUNT(*)-1 denominator introduced in
    260615-rb1) still over-excluded short fully-analyzed games whose terminal position
    had no eval, causing ~0.17% divergence. full_evals_completed_at is set by the drain
    only when the kernel itself is satisfied, so it is the definitive source of truth.
    The (COUNT-1) denominator narrative in 260615-rb1 no longer applies to this path.
    """
    return (
        select(Game.id.label("game_id"))
        .where(Game.user_id == user_id, Game.full_evals_completed_at.isnot(None))
        .subquery("analyzed")
    )


async def count_filtered_and_analyzed(
    session: AsyncSession,
    user_id: int,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None = None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
    color: str | None = None,
    tactic_families: Sequence[str] | None = None,
    # Quick 260621-sm8 follow-up: neutral default "either" (was "allowed") — see
    # _filtered_games_base. Prevents the analyzed/coverage counts from being
    # silently tactic-filtered when no tactic control is set.
    tactic_filter_orientation: TacticOrientation = "either",
) -> tuple[int, int]:
    """Return (total_n, analyzed_n) over the filtered Games-surface set (LIBG-09).

    total_n   = count of games matching the filter set.
    analyzed_n = subset that is all-ply eval-complete, i.e. present in
                 _analyzed_game_ids_subquery (full_evals_completed_at IS NOT NULL).

    BUGFIX (badge/denominator mismatch): analyzed_n used to be Game.is_analyzed
    (white_blunders IS NOT NULL). That column is set at IMPORT time for lichess
    games shipping a computer-analysis block, so it counted games our engine has
    never touched. Two things broke:

    1. The Stats-tab coverage badge read "2845 of 2847" while the Games/Flaws
       badges read "2848 of 2848" — those use full_evals_completed_at
       (game_repository.count_fully_analyzed_games), as do the per-game cards'
       Analyze button. Degenerate games (drain-stamped, no move-quality columns)
       were missing from is_analyzed.
    2. Worse, analyzed_n is the rate denominator in get_flaw_stats and the gate in
       get_flaw_comparison / get_tactic_comparison, but every numerator there is
       aggregated over _analyzed_game_ids_subquery. Denominator and numerator sat
       on different populations, understating flaw rates for users with lichess
       %eval games (prod user 269: 5958 vs 1800, a ~3.3x skew).

    Both counts now derive from the same subquery the aggregates join on, so they
    cannot drift again. See .planning/notes/eval-completion-columns.md for why
    is_analyzed is not an "our engine analyzed this" signal.

    flaw_severity defaults to None so the COVERAGE badge (get_flaw_stats) gets a
    true "x of y" denominator: when it is None the base spans the whole filtered
    game set, so total_n counts unanalyzed games too and analyzed_n <= total_n.
    Passing a flaw_severity (the you-vs-opponent comparison gate does) restricts
    BOTH counts to games with a matching flaw via the base EXISTS, so analyzed_n
    there matches the set the comparison bullets aggregate over — which is why the
    badge caller must NOT pass flaw_severity (the EXISTS would collapse the
    denominator onto flawed games only).

    Both are user-scoped.
    """
    base = _filtered_games_base(
        user_id,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        flaw_severity=flaw_severity,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        color=color,
        tactic_families=tactic_families,
        tactic_orientation=tactic_filter_orientation,
    )
    base_subq = base.subquery("filtered")
    total_n = (await session.execute(select(func.count()).select_from(base_subq))).scalar_one()
    if total_n == 0:
        return 0, 0

    analyzed_subq = _analyzed_game_ids_subquery(user_id)
    analyzed_stmt = select(func.count()).select_from(
        select(base_subq.c.id).where(base_subq.c.id.in_(select(analyzed_subq.c.game_id))).subquery()
    )
    analyzed_n = (await session.execute(analyzed_stmt)).scalar_one()
    return total_n, analyzed_n


async def analyzed_game_ids(
    session: AsyncSession,
    user_id: int,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
    color: str | None = None,
) -> list[int]:
    """Return the analyzed (>=90% coverage) filtered game_ids, played_at ASC.

    The chronological game-id list the stats service iterates for its per-game
    kernel re-call (D1 pragmatic path) and rolling-GAME-window trend (D3). Same
    filter set + analyzed gate as count_filtered_and_analyzed; ordered oldest
    first so the trend windows accumulate in play order. User-scoped.
    """
    base = _filtered_games_base(
        user_id,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        flaw_severity=flaw_severity,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        color=color,
    )
    base_subq = base.subquery("filtered")
    analyzed_subq = _analyzed_game_ids_subquery(user_id)
    stmt = (
        select(Game.id)
        .where(
            Game.id.in_(select(base_subq.c.id)),
            Game.id.in_(select(analyzed_subq.c.game_id)),
        )
        .order_by(Game.played_at.asc().nulls_last())
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)


async def fetch_flaw_comparison(
    session: AsyncSession,
    user_id: int,
    analyzed_game_ids_subq: Subquery,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    opponent_gap_min: int | None,
    opponent_gap_max: int | None,
    color: str | None,
) -> list[Any]:
    """Per-game player/opp counts for all 15 metrics over the analyzed+filtered set.

    LEFT JOIN anchor: analyzed+filtered games list → LEFT JOIN game_flaws so games
    with zero flaws contribute a zero-delta row (§5 all-analyzed-games basis,
    Pitfall 1 / FLAWCMP-01).
    Returns one row per (game_id, user_moves) with 30 COUNT columns (15 player +
    15 opp). Python aggregates mean + CI per metric.

    Pitfall 2 (divide-by-zero): games with ply_count IS NULL or ply_count = 0
    are excluded at the anchor level — _analyzed_game_ids_subquery does NOT
    filter ply_count. Use func.count(GameFlaw.ply) NOT func.count() so absent
    LEFT-JOIN rows (NULL ply) are not counted. Use is_opponent_expr from
    query_utils — never inline ply % 2 math (CONTEXT D-01, Pitfall 3).
    """
    base_filtered_subq = _filtered_games_base(
        user_id,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        flaw_severity=flaw_severity,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        color=color,
    ).subquery("filtered_fc")

    # Anchor: analyzed+filtered games with valid ply_count (Pitfall 2 — divide-by-zero guard)
    anchor_subq = (
        select(
            Game.id.label("game_id"),
            Game.user_color,
            case(
                (Game.user_color == "white", func.floor(Game.ply_count / 2.0)),
                else_=func.ceil(Game.ply_count / 2.0),
            ).label("user_moves"),
        )
        .where(
            Game.user_id == user_id,
            Game.id.in_(select(base_filtered_subq.c.id)),
            Game.id.in_(select(analyzed_game_ids_subq.c.game_id)),
            Game.ply_count.isnot(None),
            Game.ply_count > 0,
        )
        .subquery("anchor")
    )

    # LEFT JOIN game_flaws — 30 COUNT(GameFlaw.ply) FILTER columns (15 metrics × 2 sides).
    # func.count(GameFlaw.ply) (not func.count()) ensures NULL ply from LEFT JOIN miss = 0.
    stmt = (
        select(
            anchor_subq.c.game_id,
            anchor_subq.c.user_moves,
            # --- Severity family ---
            # flaw_rate: mistake OR blunder
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity.in_([_SEVERITY_INT["mistake"], _SEVERITY_INT["blunder"]]),
            )
            .label("player_flaw_rate"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity.in_([_SEVERITY_INT["mistake"], _SEVERITY_INT["blunder"]]),
            )
            .label("opp_flaw_rate"),
            # mistake
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity == _SEVERITY_INT["mistake"],
            )
            .label("player_mistake"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity == _SEVERITY_INT["mistake"],
            )
            .label("opp_mistake"),
            # blunder
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity == _SEVERITY_INT["blunder"],
            )
            .label("player_blunder"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.severity == _SEVERITY_INT["blunder"],
            )
            .label("opp_blunder"),
            # --- Tempo family ---
            # low_clock
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["low-clock"],
            )
            .label("player_low_clock"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["low-clock"],
            )
            .label("opp_low_clock"),
            # hasty
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["hasty"],
            )
            .label("player_hasty"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["hasty"],
            )
            .label("opp_hasty"),
            # unrushed
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["unrushed"],
            )
            .label("player_unrushed"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["unrushed"],
            )
            .label("opp_unrushed"),
            # --- Phase family ---
            # opening
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.phase == _PHASE_INT["opening"],
            )
            .label("player_opening"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.phase == _PHASE_INT["opening"],
            )
            .label("opp_opening"),
            # middlegame
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.phase == _PHASE_INT["middlegame"],
            )
            .label("player_middlegame"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.phase == _PHASE_INT["middlegame"],
            )
            .label("opp_middlegame"),
            # endgame_phase
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.phase == _PHASE_INT["endgame"],
            )
            .label("player_endgame_phase"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.phase == _PHASE_INT["endgame"],
            )
            .label("opp_endgame_phase"),
            # --- Opportunity family ---
            # miss
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_miss.is_(True),
            )
            .label("player_miss"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_miss.is_(True),
            )
            .label("opp_miss"),
            # lucky
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_lucky.is_(True),
            )
            .label("player_lucky"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_lucky.is_(True),
            )
            .label("opp_lucky"),
            # --- Impact family ---
            # reversed
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_reversed.is_(True),
            )
            .label("player_reversed"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_reversed.is_(True),
            )
            .label("opp_reversed"),
            # squandered
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_squandered.is_(True),
            )
            .label("player_squandered"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.is_squandered.is_(True),
            )
            .label("opp_squandered"),
            # --- Combo family ---
            # hasty_miss: hasty AND miss
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["hasty"],
                GameFlaw.is_miss.is_(True),
            )
            .label("player_hasty_miss"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["hasty"],
                GameFlaw.is_miss.is_(True),
            )
            .label("opp_hasty_miss"),
            # low_clock_miss: low-clock AND miss (D-12: ships despite degenerate zone)
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["low-clock"],
                GameFlaw.is_miss.is_(True),
            )
            .label("player_low_clock_miss"),
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                GameFlaw.tempo == _TEMPO_INT["low-clock"],
                GameFlaw.is_miss.is_(True),
            )
            .label("opp_low_clock_miss"),
        )
        .outerjoin(
            GameFlaw,
            (GameFlaw.game_id == anchor_subq.c.game_id) & (GameFlaw.user_id == user_id),
        )
        .group_by(anchor_subq.c.game_id, anchor_subq.c.user_moves, anchor_subq.c.user_color)
    )
    rows = (await session.execute(stmt)).all()
    return list(rows)


async def fetch_tactic_comparison(
    session: AsyncSession,
    user_id: int,
    analyzed_game_ids_subq: Subquery,
    *,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    flaw_severity: Sequence[str] | None,
    opponent_gap_min: int | None,
    opponent_gap_max: int | None,
    color: str | None,
    tactic_families: Sequence[str] | None = None,
    tactic_confidence_min: int = _TACTIC_CHIP_CONFIDENCE_MIN,
    orientation: TacticOrientation = "allowed",
    tactic_filter_orientation: TacticOrientation = "allowed",
) -> list[Any]:
    """Per-game player/opp counts for all 10 tactic families over the analyzed+filtered set.

    LEFT JOIN anchor: analyzed+filtered games list → LEFT JOIN game_flaws (orientation
    tactic_motif IS NOT NULL AND tactic_confidence >= tactic_confidence_min) so games with
    zero qualifying tactic flaws contribute a zero-count row.
    Phase 128 D-09: orientation selects the column set (allowed/missed) for both the
    LEFT JOIN gate and the COUNT FILTER predicates.

    SEED-062: orientation drives ONLY the COUNT column set; tactic_filter_orientation
    drives the tactic_families narrowing of the base game population. The comparison
    grid shows both orientations, so the service passes tactic_filter_orientation=
    "either" for both the missed and allowed fetches — both bullet populations then
    share one basis (games with a family-X tactic in either column) and match the
    gate's analyzed_n denominator, instead of inheriting the "allowed"-only default.

    Returns one row per game_id with 20 COUNT columns (10 families × player/opp).
    Python aggregates mean + CI per family in the service layer.

    Uses is_opponent_expr from query_utils — never inline ply % 2 (CONTEXT D-01, Pitfall 3).
    """
    base_filtered_subq = _filtered_games_base(
        user_id,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        flaw_severity=flaw_severity,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
        color=color,
        tactic_families=tactic_families,
        tactic_orientation=tactic_filter_orientation,
    ).subquery("filtered_tc")

    # Anchor: analyzed+filtered games with valid ply_count (Pitfall 2 — divide-by-zero guard)
    anchor_subq = (
        select(
            Game.id.label("game_id"),
            Game.user_color,
        )
        .where(
            Game.user_id == user_id,
            Game.id.in_(select(base_filtered_subq.c.id)),
            Game.id.in_(select(analyzed_game_ids_subq.c.game_id)),
            Game.ply_count.isnot(None),
            Game.ply_count > 0,
        )
        .subquery("anchor_tc")
    )

    # Build 20 COUNT columns (10 families × player/opp).
    # orientation_tactic_motif IS NOT NULL AND orientation_tactic_confidence >= threshold
    # gates the LEFT JOIN so only qualifying (confident enough) tactic events are counted.
    # Phase 128 D-09: _tactic_cols resolves the column pair from orientation (closed enum).
    # func.count(GameFlaw.ply) (not func.count()) ensures NULL ply from LEFT JOIN miss = 0.
    # is_opponent_expr — never inline ply % 2 (CONTEXT D-01, Pitfall 3).
    motif_col, conf_col = _tactic_cols(orientation)
    count_cols = []
    for family, motif_ints in FAMILY_TO_MOTIF_INTS.items():
        count_cols.append(
            func.count(GameFlaw.ply)
            .filter(
                ~is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                motif_col.in_(motif_ints),
            )
            .label(f"player_{family}")
        )
        count_cols.append(
            func.count(GameFlaw.ply)
            .filter(
                is_opponent_expr(GameFlaw.ply, anchor_subq.c.user_color),
                motif_col.in_(motif_ints),
            )
            .label(f"opp_{family}")
        )

    stmt = (
        select(anchor_subq.c.game_id, *count_cols)
        .outerjoin(
            GameFlaw,
            (GameFlaw.game_id == anchor_subq.c.game_id)
            & (GameFlaw.user_id == user_id)
            & motif_col.isnot(None)
            & (conf_col >= tactic_confidence_min),
        )
        .group_by(anchor_subq.c.game_id, anchor_subq.c.user_color)
    )
    rows = (await session.execute(stmt)).all()
    return list(rows)


# ---------------------------------------------------------------------------
# Phase 135 — Tactic Line Explorer: PV→SAN helpers + fetch_tactic_lines()
# ---------------------------------------------------------------------------


def pv_to_san_list(board: chess.Board, pv: str | None) -> list[str] | None:
    """Convert a space-joined UCI PV string to a SAN list.

    Walks each UCI move from `board`, returning SAN for each position visited.
    Returns None when pv is falsy (NULL/empty) or unparseable.
    ValueError from _parse_pv (bad UCI) is an expected/graceful case — do NOT
    capture_exception (CLAUDE.md: skip expected exceptions; T-135-04 accept).

    Public (190-02): this walk was previously module-private; promoted so
    `app.repositories.train_repository`'s reveal path can reuse this exact
    walk for `PuzzleRevealResponse.pv` rather than re-deriving a second one.
    """
    if not pv:
        return None
    try:
        boards, moves = _parse_pv(board, pv)
    except ValueError:
        return None
    return [boards[i].san(moves[i]) for i in range(len(moves))]


async def fetch_tactic_lines(
    session: AsyncSession,
    *,
    game_id: int,
    ply: int,
) -> TacticLinesResponse | None:
    """Fetch and convert the PV walk data for the TacticLineExplorer (Phase 135).

    Returns None when there is no game_flaws row for (game_id, ply) — the caller
    raises 404.

    Quick 260717-agv: NOT owner-scoped. game_id is globally unique (games.id PK)
    and determines the owner, so (game_id, ply) resolves the owner's flaw without
    a requester filter — any authenticated user inspecting the game on the
    analysis page may expand its tactic lines (mirrors get_library_game).

    Queries game_flaws for the flaw metadata (FEN, tactic depths, motifs) then
    game_positions at ply and ply+1 for the two PV strings. Sequential awaits —
    NEVER asyncio.gather on one AsyncSession (CLAUDE.md constraint).

    PV anchoring (Research Finding 2):
    - Missed PV: from board_before (decision board, no flaw move pushed).
    - Allowed PV: from board_after_flaw (flaw move pushed), then prepend the
      flaw move SAN so allowed_moves[0] is the red error move (Pitfall 3).

    FEN returned as a full FEN (with side-to-move from ply parity) so chess.js
    can initialize the board without client-side ply arithmetic (Pitfall 2).

    Raw 0-based depths are returned as-is; the +1 display offset and the
    ALLOWED_DECISION_DEPTH_OFFSET are applied client-side via
    toDisplayDepthForOrientation() in frontend/src/lib/tacticDepth.ts
    (Research Finding 2).
    """
    # 1. Fetch the flaw row. game_id uniquely determines the owner, so no
    # user_id filter is needed (Quick 260717-agv: cross-user analysis view).
    flaw_q = await session.execute(
        select(GameFlaw).where(
            GameFlaw.game_id == game_id,
            GameFlaw.ply == ply,
        )
    )
    flaw = flaw_q.scalar_one_or_none()
    if flaw is None:
        return None  # caller raises 404

    # 2. Fetch game_positions at ply-1, ply and ply+1 — sequential, not asyncio.gather.
    # ply-1 is needed for the missed (decision-position) eval: game_positions.eval_cp is
    # the POST-MOVE eval (eval of the position AFTER that ply's move, see eval_drain.py),
    # so the decision position's own eval is stored on the PREVIOUS row (ply-1).
    pos_q = await session.execute(
        select(GamePosition).where(
            GamePosition.game_id == game_id,
            GamePosition.ply.in_([ply - 1, ply, ply + 1]),
        )
    )
    positions: dict[int, GamePosition] = {p.ply: p for p in pos_q.scalars().all()}

    pos_prev = positions.get(ply - 1)
    pos_n = positions.get(ply)
    pos_n1 = positions.get(ply + 1)

    # 3. Reconstruct the decision board from board_fen() + ply parity.
    # game_flaws.fen stores board_fen() (piece-placement only, no side-to-move).
    # Same logic as _detect_tactic_for_flaw in flaws_service.py:445-446.
    board_before = chess.Board(flaw.fen)
    board_before.turn = chess.WHITE if ply % 2 == 0 else chess.BLACK

    # 4. Convert missed PV from decision board (board_before, no flaw move pushed).
    # Full PV (no truncation, Phase 135 UAT) — show every move the engine returned.
    missed_pv = pos_n.pv if pos_n is not None else None
    missed_sans = pv_to_san_list(board_before.copy(), missed_pv)

    # 5. Build allowed PV: push flaw move to get board_after_flaw, convert pos[n+1].pv,
    #    then prepend the flaw move SAN so allowed_moves[0] is the red error move.
    allowed_sans: list[str] | None = None
    flaw_move_san: str | None = pos_n.move_san if pos_n is not None else None
    if flaw_move_san is not None and pos_n is not None:
        try:
            flaw_move = board_before.parse_san(flaw_move_san)
            board_after_flaw = board_before.copy()
            board_after_flaw.push(flaw_move)
            allowed_pv = pos_n1.pv if pos_n1 is not None else None
            allowed_raw = pv_to_san_list(board_after_flaw, allowed_pv)
            if allowed_raw is not None:
                allowed_sans = [flaw_move_san] + allowed_raw
        except (ValueError, chess.InvalidMoveError):
            # parse_san failed on a stored move_san — graceful fallback, no Sentry capture
            allowed_sans = None

    # 6. Full FEN for the decision position (with side-to-move for chess.js).
    position_fen = board_before.fen()

    # 7. Motif strings from the _INT_TO_MOTIF lookup (None when motif int is None).
    missed_motif_int = flaw.missed_tactic_motif
    allowed_motif_int = flaw.allowed_tactic_motif
    missed_motif: str | None = (
        str(_TACTIC_INT_TO_MOTIF[missed_motif_int]) if missed_motif_int is not None else None
    )
    allowed_motif: str | None = (
        str(_TACTIC_INT_TO_MOTIF[allowed_motif_int]) if allowed_motif_int is not None else None
    )

    # allowed_moves prepends the flaw move at index 0 (the red error move), so the
    # opponent-refutation punchline sits one index DEEPER in allowed_moves than its
    # raw detector depth. Shift +1 so the SAN ladder highlights the refutation move
    # (at flaw_ply+1), not the flaw move itself (Phase 135 UAT). missed_moves has no
    # prepend, so missed_tactic_ply_index stays equal to the raw depth.
    allowed_ply_index: int | None = (
        flaw.allowed_tactic_depth + 1 if flaw.allowed_tactic_depth is not None else None
    )

    return TacticLinesResponse(
        missed_moves=missed_sans,
        missed_depth=flaw.missed_tactic_depth,
        missed_tactic_ply_index=flaw.missed_tactic_depth,
        missed_motif=missed_motif,
        # Decision-position eval (board_before, ply 0 of the missed line): the eval of
        # the position the flaw move was played FROM. eval_cp is post-move, so that eval
        # lives on ply-1's row. None when ply == 0 (no prior row / game start).
        missed_eval_cp=pos_prev.eval_cp if pos_prev is not None else None,
        missed_eval_mate=pos_prev.eval_mate if pos_prev is not None else None,
        allowed_moves=allowed_sans,
        allowed_depth=flaw.allowed_tactic_depth,
        allowed_tactic_ply_index=allowed_ply_index,
        allowed_motif=allowed_motif,
        # Post-flaw eval (board after the flaw move, ply 1 of the allowed line): the
        # post-move eval of the flaw move itself, stored on ply n's row.
        allowed_eval_cp=pos_n.eval_cp if pos_n is not None else None,
        allowed_eval_mate=pos_n.eval_mate if pos_n is not None else None,
        position_fen=position_fen,
        flaw_move_san=flaw_move_san,
        best_move_uci=pos_n.best_move if pos_n is not None else None,
        flaw_ply=ply,
        flaw_severity=_SEVERITY_INT_TO_TAG[flaw.severity],
    )
