"""Phase 70 (v1.13) opening insights service.

Single public entry point: compute_insights(session, user_id, request).
Pipeline: query_opening_transitions (per color) -> classify + severity ->
attribute (deepest Opening / lineage walk / drop on no match) ->
dedupe within color section -> rank (severity desc, n_games desc) ->
cap per section (5 weaknesses, 3 strengths). No precompute, no caching
(D-29) — partial-index-backed query keeps even Hikaru-class users <1 s.

See .planning/phases/70-backend-opening-insights-service/70-CONTEXT.md
for D-01..D-34 locked decisions.
"""

import ctypes
import datetime
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from types import SimpleNamespace  # Phase 80.1: adapter for resulting-position W/D/L
from typing import Any, Literal

import chess
import chess.polyglot
import sentry_sdk
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.opening import Opening
from app.repositories.openings_repository import (
    query_opening_transitions,
    query_openings_by_hashes,
    query_resulting_position_wdl,  # Phase 80.1 D-03: resulting-position WDL
    query_transition_prefixes,
)
from app.repositories.stats_repository import (
    OpeningPhaseEntryMetrics,
    query_opening_phase_entry_metrics_batch,
)
from app.schemas.opening_insights import (
    OpeningInsightFinding,
    OpeningInsightsRequest,
    OpeningInsightsResponse,
)
from app.services.eval_confidence import compute_eval_confidence_bucket
from app.services.opening_insights_constants import (
    EVAL_BASELINE_PAWNS_BLACK,
    EVAL_BASELINE_PAWNS_WHITE,
    OPENING_INSIGHTS_MAJOR_EFFECT as MAJOR_EFFECT,
    OPENING_INSIGHTS_MINOR_EFFECT as MINOR_EFFECT,
    OPENING_INSIGHTS_SCORE_PIVOT as SCORE_PIVOT,
)
from app.services.score_confidence import compute_confidence_bucket, wilson_bounds

# ---------------------------------------------------------------------------
# Phase 75 thresholds. Score-based effect-size gate (D-03, D-11) and Wilson
# score-test confidence buckets (D-05, D-06; migrated from trinomial Wald in
# quick 260507-aw5) are imported from app.services.opening_insights_constants
# above. The CI consistency test
# (tests/services/test_opening_insights_arrow_consistency.py) keeps the
# backend constants and frontend/src/lib/arrowColor.ts in lock-step.
# ---------------------------------------------------------------------------

# Phase 71 UAT: caps raised to 10 (was 5 weak / 3 strong) so the FE can render
# 5 visible cards per section with a "X more" toggle expanding up to 10, all in
# a single roundtrip.
WEAKNESS_CAP_PER_COLOR: int = 10
STRENGTH_CAP_PER_COLOR: int = 10
UNNAMED_LINE_NAME: str = "<unnamed line>"
UNNAMED_LINE_ECO: str = ""

# Phase 80.1: surfaced when the resulting-position WDL lookup misses a
# resulting_full_hash that came back from query_opening_transitions. Should be
# zero under correct filter parity; non-zero indicates a divergence between the
# two query call sites that needs investigation.
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helper functions
# ---------------------------------------------------------------------------


def _classify_row(
    row: Any,
) -> tuple[Literal["weakness", "strength"], Literal["minor", "major"]] | None:
    """Classify a transition row by chess score against the 0.50 pivot (D-11).

    Score is (W + 0.5·D) / N. Effect-size thresholds are symmetric:
      - weakness: score <= 0.45 → minor; <= 0.40 → major
      - strength: score >= 0.55 → minor; >= 0.60 → major
    Strict <= / >= boundaries (D-03). Returns None for neutral positions.
    Phase 75 D-09 promoted score from informative to canonical metric.

    Compare score directly against precomputed pivot ± effect thresholds rather
    than against `delta = score - PIVOT`. The literal score values produced by
    integer-row factories (e.g. 0.45 = 9/20) are exactly equal to PIVOT ± EFFECT
    in IEEE-754 (0.50 - 0.05 == 0.45 exactly), but `0.45 - 0.50 == -0.04999…`,
    which would silently miss strict-<= boundary cases. Direct comparison keeps
    the strict <= / >= semantics on the boundary.
    """
    score = (row.w + 0.5 * row.d) / row.n
    weakness_minor_threshold = SCORE_PIVOT - MINOR_EFFECT  # 0.45
    weakness_major_threshold = SCORE_PIVOT - MAJOR_EFFECT  # 0.40
    strength_minor_threshold = SCORE_PIVOT + MINOR_EFFECT  # 0.55
    strength_major_threshold = SCORE_PIVOT + MAJOR_EFFECT  # 0.60
    if score <= weakness_minor_threshold:
        severity: Literal["minor", "major"] = (
            "major" if score <= weakness_major_threshold else "minor"
        )
        return "weakness", severity
    if score >= strength_minor_threshold:
        severity = "major" if score >= strength_major_threshold else "minor"
        return "strength", severity
    return None


def _compute_score(row: Any) -> float:
    """Compute score = (W + D/2) / n (Phase 75 D-09: canonical classification metric)."""
    return (row.w + row.d / 2) / row.n


def _replay_san_sequence(san_sequence: list[str]) -> str:
    """Replay a SAN sequence from the start position.

    Implements D-25 entry-FEN reconstruction by replaying the exact moves
    the user played up to the entry position. With MIN_ENTRY_PLY=0 an empty
    sequence is valid and corresponds to the starting position itself
    (entry_ply=0, where the candidate is white's first move).
    """
    board = chess.Board()
    for san in san_sequence:
        board.push_san(san)
    return board.fen()


def _apply_display_name_parity(
    name: str,
    opening_ply_count: int,
    finding_color: Literal["white", "black"],
) -> str:
    """Apply 'vs. ' prefix when attribution parity disagrees with finding color.

    A white-defined opening has odd ply_count (white's move last);
    a black-defined opening has even ply_count. When the finding's color
    disagrees with the opening's parity, prefix with 'vs. ' per RESEARCH.md
    Pitfall 4 and stats_repository.py lines 250-260.
    """
    user_parity = 1 if finding_color == "white" else 0
    if opening_ply_count % 2 != user_parity:
        return f"vs. {name}"
    return name


def _signed_full_hash(board: chess.Board) -> int:
    """Return the signed int64 Zobrist hash for the current board position.

    Identical conversion to STARTING_POSITION_HASH in openings_repository and
    _compute_prefix_hashes: ctypes.c_int64 wraps the unsigned 64-bit polyglot
    hash to match the signed BIGINT stored on GamePosition.full_hash.
    """
    return ctypes.c_int64(chess.polyglot.zobrist_hash(board)).value


def _compute_prefix_hashes(san_sequence: list[str]) -> list[int]:
    """Return the full_hash for every proper prefix (deepest first).

    BLOCKER-2: hashes MUST be converted via ctypes.c_int64(...).value to
    match the signed int64 stored on GamePosition.full_hash. Without this
    conversion, lookups against the openings table (whose Opening.full_hash
    is also signed via the same path) would silently miss every match.
    """
    board = chess.Board()
    hashes: list[int] = []
    for san in san_sequence:
        board.push_san(san)
        hashes.append(_signed_full_hash(board))
    # Drop the LAST entry (full sequence == the entry position itself, which
    # was already covered by direct attribution). Deepest parent first.
    return list(reversed(hashes[:-1]))


def _attribute_finding(
    row: Any,
    openings_by_hash: dict[int, Opening],
    parents_by_hash: dict[int, Opening],
    finding_color: Literal["white", "black"],
) -> tuple[str, str, str] | None:
    """Attribute a finding to an opening name (BLOCKER-1 / D-22 / D-23 / D-34).

    Returns (opening_name, opening_eco, display_name) or None when no match
    is found at any lineage depth — None causes the finding to be DROPPED
    per D-34 (never surfaced with a sentinel name).

    Attribution path:
    1. Direct: look up entry_hash in openings_by_hash.
    2. Lineage walk: check parent prefix hashes in parents_by_hash (deepest first).
    3. ply=0 fallback: when san_seq is empty (entry IS the starting position),
       attribute by resulting_full_hash so e.g. "1.e4" surfaces as
       "King's Pawn Opening" via the position AFTER the candidate move. The
       openings table has min(ply_count)=1 so direct attribution always misses
       at ply=0; this fallback keeps the relaxed MIN_ENTRY_PLY=0 actually
       useful instead of silently dropping every first-move finding.
    4. No match → return None. Sentry tag set by calling pipeline on drop.
    """
    entry_hash_int = int(row.entry_hash)

    # Pass 1: direct attribution
    direct_opening = openings_by_hash.get(entry_hash_int)
    if direct_opening is not None:
        display_name = _apply_display_name_parity(
            direct_opening.name, direct_opening.ply_count, finding_color
        )
        return direct_opening.name, direct_opening.eco, display_name

    # Pass 2: lineage walk (deepest first). With MIN_ENTRY_PLY=0, ply=0
    # entries have a NULL entry_san_sequence (array_agg over empty window):
    # there is no parent lineage to walk in that case, so an empty list
    # short-circuits the loop and we fall through to the ply=0 fallback.
    san_seq = list(row.entry_san_sequence or [])
    for prefix_hash in _compute_prefix_hashes(san_seq):
        parent_opening = parents_by_hash.get(prefix_hash)
        if parent_opening is not None:
            display_name = _apply_display_name_parity(
                parent_opening.name, parent_opening.ply_count, finding_color
            )
            return parent_opening.name, parent_opening.eco, display_name

    # Pass 3: ply=0 fallback via resulting_full_hash (only when san_seq is
    # empty — i.e. entry IS the starting position).
    if not san_seq:
        result_hash_int = int(row.resulting_full_hash)
        result_opening = openings_by_hash.get(result_hash_int)
        if result_opening is not None:
            display_name = _apply_display_name_parity(
                result_opening.name, result_opening.ply_count, finding_color
            )
            return result_opening.name, result_opening.eco, display_name

    # No match at any depth — D-34: drop this finding
    return None


def _dedupe_within_section(
    items: list[tuple[OpeningInsightFinding, int, float]],
) -> list[tuple[OpeningInsightFinding, float]]:
    """Deduplicate by resulting_full_hash within a section, keeping the deepest entry.

    D-24: when two findings share resulting_full_hash in the same color section,
    keep the one with the higher attribution ply_count (deeper opening wins).

    Quick task 260428-tgg: also threads `se` through. Returns (finding, se) tuples
    — opening_ply_count is consumed here and does not flow downstream to ranking.
    """
    best: dict[str, tuple[OpeningInsightFinding, int, float]] = {}
    for finding, ply_count, se in items:
        key = finding.resulting_full_hash
        existing = best.get(key)
        if existing is None or ply_count > existing[1]:
            best[key] = (finding, ply_count, se)
    return [(finding, se) for finding, _ply, se in best.values()]


def _robustness(finding: OpeningInsightFinding) -> float:
    """Directional Wilson-bound signal strength.

    Positive = the 95% CI puts the true score on the claimed side of 0.50;
    near-zero or negative = the CI straddles 0.50 and the finding is mostly
    noise. Combines effect size and sample-size uncertainty into a single
    continuous metric, replacing the old categorical confidence-bucket
    comparison in dedupe (which had nothing to do with line-collapse choice
    until MIN_ENTRY_PLY=0 surfaced low-signal shallow findings that began
    pre-empting more informative deeper ones).

    For weakness: 0.5 - wilson_upper(score, n)
        — how far below 0.50 the upper bound sits; large = robust weakness.
    For strength: wilson_lower(score, n) - 0.5
        — how far above 0.50 the lower bound sits; large = robust strength.
    """
    lower, upper = wilson_bounds(finding.score, finding.n_games)
    if finding.classification == "weakness":
        return SCORE_PIVOT - upper
    return lower - SCORE_PIVOT


def _dedupe_continuations(
    sections: dict[str, list[tuple[OpeningInsightFinding, float]]],
) -> dict[str, list[tuple[OpeningInsightFinding, float]]]:
    """Collapse each line to its single most-robust finding.

    Phase 71 UAT fix: when consecutive moves in the same line are all weak
    (or all strong), deeper findings crowd the block with the same opening
    line (e.g. Caro-Kann B10: 3.exd5, 3...cxd5, 4.d4 all surfacing as
    separate cards). Originally we kept the SHALLOWEST entry per chain on
    the assumption that earlier-in-the-line is more actionable, but with
    MIN_ENTRY_PLY=0 a low-signal ply=1 finding (CI straddling 0.50) would
    pre-empt a high-signal ply=4 finding in the same line.

    Rule: iterate findings most-robust-first (Wilson-bound directional
    signal); a finding is dropped if its full_path = entry + [candidate] is
    prefix-related (either direction) to any already-kept finding's
    full_path. Two findings share a line iff one full_path is a prefix of
    the other. Tie-breaks (after `-robustness`): shallower depth, major
    severity, higher n_games — matches the legacy ordering when
    robustness ties so behavior is unchanged for findings that were
    indistinguishable under the old rule.

    Applied globally across all four sections so chains crossing color
    boundaries (white candidate → black candidate → white candidate) still
    consolidate.

    Quick task 260428-tgg: payload is `(finding, se)` so SE survives this
    stage and reaches _rank_section.
    """
    flat: list[tuple[str, OpeningInsightFinding, float]] = [
        (sk, f, se) for sk, items in sections.items() for f, se in items
    ]
    flat.sort(
        key=lambda kf: (
            -_robustness(kf[1]),
            len(kf[1].entry_san_sequence),
            0 if kf[1].severity == "major" else 1,
            -kf[1].n_games,
        )
    )

    kept_keys: set[tuple[str, str, str]] = set()
    kept_paths: list[tuple[str, tuple[str, ...]]] = []
    for section_key, finding, _se in flat:
        full_path = tuple(finding.entry_san_sequence) + (finding.candidate_move_san,)
        same_line = False
        for kept_section_key, kp in kept_paths:
            shares_line = (len(full_path) >= len(kp) and full_path[: len(kp)] == kp) or (
                len(kp) >= len(full_path) and kp[: len(full_path)] == full_path
            )
            if not shares_line:
                continue
            # D-21 exception: same exact transition reached from different
            # color perspectives is two distinct findings (e.g. user plays
            # both colors → "as white, opponents respond with X" and "as
            # black, you play X" both clear the gates). Keep both.
            if full_path == kp and section_key != kept_section_key:
                continue
            same_line = True
            break
        if same_line:
            continue
        kept_keys.add((section_key, finding.entry_full_hash, finding.candidate_move_san))
        kept_paths.append((section_key, full_path))

    result: dict[str, list[tuple[OpeningInsightFinding, float]]] = {k: [] for k in sections}
    for section_key, items in sections.items():
        for finding, se in items:
            if (section_key, finding.entry_full_hash, finding.candidate_move_san) in kept_keys:
                result[section_key].append((finding, se))
    return result


def _rank_section(
    findings_with_se: list[tuple[OpeningInsightFinding, float]],
    direction: Literal["weakness", "strength"],
) -> list[OpeningInsightFinding]:
    """Sort findings by direction-aware Wilson 95% CI bound on the score, clamped to [0, 1].

    - weakness: ascending Wilson upper bound — the row whose score is
      most-confidently-below-0.5 (smallest plausible best case) sorts first.
    - strength: descending Wilson lower bound — the row whose score is
      most-confidently-above-0.5 (largest plausible worst case) sorts first.

    Wilson replaces the earlier Wald `score +/- 1.96 * SE` formula (quick task
    260428-v9i). Wald degenerates at boundary scores (e.g. 0/11 -> SE=0, CI
    width=0, claiming 100% certainty); Wilson is well-defined for any p in
    [0, 1] and tighter for small n, so small-N extreme findings no longer
    outrank large-N moderate findings purely on score.

    The `(finding, se)` tuple shape is preserved upstream because SE is still
    produced by compute_confidence_bucket for the UI confidence badge, but
    Wilson uses only `finding.score` and `finding.n_games` — the SE component
    of the tuple is intentionally ignored here.

    Confidence bucket is no longer part of the sort key (260428-tgg follow-up):
    the CI bound already mixes effect size and sample size, so a high-N
    moderate-effect row that lives in the "medium" bucket can legitimately
    rank above a small-N extreme-effect row in the "high" bucket when its
    bound is more striking. Bucket is retained as a UI badge only.
    """

    def sort_key(item: tuple[OpeningInsightFinding, float]) -> float:
        finding, _se = item  # SE unused under Wilson; preserved for upstream compatibility
        lower, upper = wilson_bounds(finding.score, finding.n_games)
        if direction == "weakness":
            return upper
        # Negate so default ascending sort yields lower-bound descending.
        return -lower

    ranked = sorted(findings_with_se, key=sort_key)
    return [f for f, _se in ranked]


# ---------------------------------------------------------------------------
# MG-entry eval helpers (quick task 260506-u2b — parity with OpeningWDL)
# ---------------------------------------------------------------------------


def _apply_eval_metrics_to_finding(
    finding: OpeningInsightFinding,
    pe: OpeningPhaseEntryMetrics,
) -> OpeningInsightFinding:
    """Populate the six MG-entry eval fields on a finding from phase-entry metrics.

    Mirrors the finalizer logic in stats_service._phase80_item_from_metrics so
    there is a single source of eval math without duplicating SQL or confidence
    bucket computation. The H0 is 0 cp (engine-balanced) per quick task 260504-rvh.
    """
    if pe.eval_n_mg <= 0:
        return finding

    confidence_mg, p_value_mg, mean_cp_mg, ci_half_mg = compute_eval_confidence_bucket(
        pe.eval_sum_mg,
        pe.eval_sumsq_mg,
        pe.eval_n_mg,
    )
    return finding.model_copy(
        update={
            "avg_eval_pawns": mean_cp_mg / 100.0,
            "eval_ci_low_pawns": (mean_cp_mg - ci_half_mg) / 100.0 if pe.eval_n_mg >= 2 else None,
            "eval_ci_high_pawns": (mean_cp_mg + ci_half_mg) / 100.0 if pe.eval_n_mg >= 2 else None,
            "eval_n": pe.eval_n_mg,
            "eval_p_value": p_value_mg,
            "eval_confidence": confidence_mg,
        }
    )


# ---------------------------------------------------------------------------
# compute_insights stage helpers (quick task 260509-gm9 mechanical extraction)
#
# compute_insights reads as a short pipeline:
#   1. _collect_attribution_hashes  — pass-1 transitions + direct openings lookup
#   2. _fetch_position_wdl_per_color — pass-2 parent walk + per-color WDL fetch
#   3. _build_sections              — classify → attribute → dedupe → rank → cap → eval enrich
# Each helper is module-private and called sequentially; no behavior changes.
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _TransitionRow:
    """Typed wrapper for one transition, combining SQL-level and Python-derived attrs.

    SQL-level attrs (from query_opening_transitions):
        entry_hash, move_san, sample_pair=[ply, game_id], n, w, d, l, last_played_at

    Python-derived attrs (added by _wrap_transition_row):
        entry_san_sequence  — SAN prefix from start to entry position (plies 0..ply-1)
        resulting_full_hash — Zobrist hash after replaying entry_san_sequence + move_san

    sample_game_id / sample_ply are unpacked from sample_pair and stored on the
    wrapper for downstream prefix lookup + Sentry context.
    """

    entry_hash: int
    move_san: str
    sample_game_id: int
    sample_ply: int
    n: int
    w: int
    d: int
    l: int  # noqa: E741 — 'l' matches SQL label and fixture convention throughout
    last_played_at: datetime.datetime | None
    entry_san_sequence: list[str]
    resulting_full_hash: int


def _wrap_transition_row(
    raw_row: Any,
    prefixes: dict[tuple[int, int], list[str]],
) -> _TransitionRow | None:
    """Wrap a raw SQL row from query_opening_transitions into a typed _TransitionRow.

    Derives entry_san_sequence from the prefixes dict and resulting_full_hash by
    replaying the SAN sequence on a fresh chess.Board.

    Returns None on either of two distinct, deliberately separate drop reasons:

    1. No standard-start sample. Phase 210 (SEED-042) filters the sample aggregate
       to `initial_fen IS NULL`, so a group in which EVERY game is custom-start
       yields a NULL `sample_pair`. There is no replayable SAN path to this
       position, so the group cannot be rendered.
    2. Replay failure. A defensive residual — with (1) filtered upstream the
       prefix should always be reachable, so this firing means something else is
       wrong (a corrupt PGN, an unmarked custom start).

    Both are expected, handled conditions rather than errors, so both report at
    warning level (D-07). Keeping them as separate messages matters: collapsing
    them would make the Sentry payload lie about which one fired.
    """
    # sample_pair is ARRAY[ply, game_id] from one real STANDARD-START row in the
    # group (paired aggregate — independent MIN(ply)/MIN(game_id) would
    # de-correlate under transposition). asyncpg returns it as a 2-element list,
    # and a NULL aggregate as None (NOT an empty list — the guard must be
    # `is None`, not a falsiness check on length).
    if raw_row.sample_pair is None:
        sentry_sdk.set_context(
            "opening_insights_drop",
            {
                "entry_hash": int(raw_row.entry_hash),
                "move_san": raw_row.move_san,
                "n": int(raw_row.n),
                "reason": "all_games_custom_start",
            },
        )
        sentry_sdk.set_tag("source", "opening_insights")
        sentry_sdk.capture_message(
            "Opening transition dropped: no standard-start sample game",
            level="warning",
        )
        return None

    sample_ply = int(raw_row.sample_pair[0])
    sample_game_id = int(raw_row.sample_pair[1])
    entry_san_sequence = prefixes.get((sample_game_id, sample_ply), [])

    try:
        board = chess.Board()
        for san in entry_san_sequence:
            board.push_san(san)
        board.push_san(raw_row.move_san)
        resulting_full_hash = _signed_full_hash(board)
    except (chess.IllegalMoveError, chess.InvalidMoveError, ValueError, AssertionError) as exc:
        # SAN prefix is unreachable from chess.Board(). Phase 210 (SEED-042)
        # removed the systematic cause (custom-start games being preferred as the
        # sample representative), so this is now a defensive residual rather than
        # the common path.
        #
        # Demoted from capture_exception to a warning-level capture_message
        # (D-07): this models a handled, expected drop, and as an exception it
        # escalated a non-bug into the issue list 74 times (FLAWCHESS-5E) while
        # the two genuinely actionable production issues sat below it. Rate
        # visibility is preserved; the escalation is not. Per CLAUDE.md the
        # message carries no variables — those stay in set_context so grouping
        # doesn't fragment.
        sentry_sdk.set_context(
            "opening_insights_drop",
            {
                "entry_hash": int(raw_row.entry_hash),
                "move_san": raw_row.move_san,
                "sample_game_id": sample_game_id,
                "sample_ply": sample_ply,
                "reason": "san_prefix_unreplayable",
                "error": str(exc),
            },
        )
        sentry_sdk.set_tag("source", "opening_insights")
        sentry_sdk.capture_message(
            "Opening transition dropped: SAN prefix unreplayable from the standard start",
            level="warning",
        )
        return None

    return _TransitionRow(
        entry_hash=int(raw_row.entry_hash),
        move_san=raw_row.move_san,
        sample_game_id=sample_game_id,
        sample_ply=sample_ply,
        n=int(raw_row.n),
        w=int(raw_row.w),
        d=int(raw_row.d),
        l=int(raw_row.l),
        last_played_at=raw_row.last_played_at,
        entry_san_sequence=entry_san_sequence,
        resulting_full_hash=resulting_full_hash,
    )


@dataclass(slots=True)
class _AttributionContext:
    """Pass-1 attribution context: per-color transition rows + direct openings lookup.

    Carried between _collect_attribution_hashes and _fetch_position_wdl_per_color.
    """

    rows_by_color: dict[str, list[_TransitionRow]] = field(default_factory=dict)
    openings_by_hash: dict[int, Opening] = field(default_factory=dict)


@dataclass(slots=True)
class _PipelineContext:
    """Combined pass-1 + pass-2 context handed to _build_sections.

    Bundles transition rows, direct opening lookup, parent-lineage lookup,
    and per-color resulting-position WDL maps so the section-builder takes
    a single context parameter rather than 4+ positional arguments.
    """

    rows_by_color: dict[str, list[_TransitionRow]]
    openings_by_hash: dict[int, Opening]
    parents_by_hash: dict[int, Opening]
    pos_wdl_by_color: dict[
        Literal["white", "black"],
        dict[int, tuple[int, int, int, datetime.datetime | None]],
    ]


async def _collect_attribution_hashes(
    session: AsyncSession,
    user_id: int,
    request: OpeningInsightsRequest,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    colors_to_query: Sequence[Literal["white", "black"]],
) -> _AttributionContext:
    """Stage 1: query transitions per color, derive Python attrs, resolve direct opening attribution.

    Runs query_opening_transitions sequentially per color (CLAUDE.md AsyncSession
    rule), then calls query_transition_prefixes once per color to batch-resolve
    SAN prefixes, wraps raw Rows into _TransitionRow (deriving entry_san_sequence
    and resulting_full_hash in Python), and looks up the union of entry hashes —
    plus resulting_full_hash for ply=0 entries so the ply=0 attribution fallback
    in `_attribute_finding` can name them by the resulting position
    (e.g. "1.e4" → "King's Pawn Opening").

    Rows where SAN replay fails (custom-FEN survivors) are dropped and Sentry-captured
    once per occurrence in _wrap_transition_row.
    """
    wrapped_by_color: dict[str, list[_TransitionRow]] = {}
    # CLAUDE.md §Critical Constraints: AsyncSession not safe for asyncio.gather.
    for color in colors_to_query:
        raw_rows = await query_opening_transitions(
            session=session,
            user_id=user_id,
            color=color,
            time_control=request.time_control,
            platform=request.platform,
            rated=request.rated,
            opponent_type=request.opponent_type,
            from_date=from_date,
            to_date=to_date,
            opponent_gap_min=request.opponent_gap_min,
            opponent_gap_max=request.opponent_gap_max,
        )
        # Unpack ARRAY[ply, game_id] into (game_id, ply) — sample_pair is paired
        # so each (game_id, ply) refers to a real row in the SQL group.
        samples = [(int(r.sample_pair[1]), int(r.sample_pair[0])) for r in raw_rows]
        prefixes = await query_transition_prefixes(session, user_id, samples)
        wrapped: list[_TransitionRow] = []
        for r in raw_rows:
            row = _wrap_transition_row(r, prefixes)
            if row is not None:
                wrapped.append(row)
        wrapped_by_color[color] = wrapped

    # Pass 1: direct attribution for all entry hashes. Also include
    # resulting_full_hash for ply=0 entries (empty SAN sequence) so the
    # ply=0 attribution fallback in `_attribute_finding` can name them
    # by the resulting position (e.g. "1.e4" → "King's Pawn Opening").
    direct_entry_hashes_set: set[int] = set()
    for rows in wrapped_by_color.values():
        for r in rows:
            direct_entry_hashes_set.add(r.entry_hash)
            if not r.entry_san_sequence:
                direct_entry_hashes_set.add(r.resulting_full_hash)
    openings_by_hash = await query_openings_by_hashes(session, list(direct_entry_hashes_set))

    return _AttributionContext(rows_by_color=wrapped_by_color, openings_by_hash=openings_by_hash)


async def _fetch_position_wdl_per_color(
    session: AsyncSession,
    user_id: int,
    request: OpeningInsightsRequest,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    colors_to_query: Sequence[Literal["white", "black"]],
    ctx: _AttributionContext,
) -> _PipelineContext:
    """Stage 2: parent-lineage attribution + per-color resulting-position WDL.

    First walks parent prefix hashes for any entry hashes that missed direct
    attribution (BLOCKER-1 / D-34), then fetches per-color resulting-position
    W/D/L (Phase 80.1 D-03/D-05) — aggregated across ALL move orders
    (transposition-inclusive). Sequential awaits per CLAUDE.md AsyncSession rule.

    WR-01: queries per color, scoped to that color's resulting_full_hash set,
    and passes color=color to query_resulting_position_wdl so the denominator
    matches query_opening_transitions' Game.user_color filter (avoids blending
    white-perspective and black-perspective games).
    """
    rows_by_color = ctx.rows_by_color
    openings_by_hash = ctx.openings_by_hash

    # Pass 2: parent-lineage attribution for unmatched (BLOCKER-1 / D-34).
    unmatched_parent_hashes: set[int] = set()
    for rows in rows_by_color.values():
        for r in rows:
            if r.entry_hash not in openings_by_hash:
                # entry_san_sequence is already a list[str] on _TransitionRow
                # (ply=0 entries legitimately have an empty list).
                unmatched_parent_hashes.update(_compute_prefix_hashes(r.entry_san_sequence))
    parents_by_hash = await query_openings_by_hashes(session, list(unmatched_parent_hashes))

    # Phase 80.1 D-03/D-05: aggregate W/D/L per resulting_full_hash across
    # ALL move orders (transposition-inclusive). Surfacing gate already ran
    # in query_opening_transitions HAVING n_games >= OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE
    # on move-played n (per D-04). The values below feed _classify_row /
    # _compute_score / compute_confidence_bucket / wilson_bounds /
    # OpeningInsightFinding via a SimpleNamespace adapter so those helpers
    # don't change.
    pos_wdl_by_color: dict[
        Literal["white", "black"], dict[int, tuple[int, int, int, datetime.datetime | None]]
    ] = {}
    for color in colors_to_query:
        color_resulting_hashes: list[int] = list(
            {r.resulting_full_hash for r in rows_by_color[color]}
        )
        if not color_resulting_hashes:
            pos_wdl_by_color[color] = {}
            continue
        pos_wdl_by_color[color] = await query_resulting_position_wdl(
            session=session,
            user_id=user_id,
            hash_list=color_resulting_hashes,
            time_control=request.time_control,
            platform=request.platform,
            rated=request.rated,
            opponent_type=request.opponent_type,
            from_date=from_date,
            to_date=to_date,
            color=color,  # per-color: matches query_opening_transitions' Game.user_color filter
            opponent_gap_min=request.opponent_gap_min,
            opponent_gap_max=request.opponent_gap_max,
        )

    return _PipelineContext(
        rows_by_color=rows_by_color,
        openings_by_hash=openings_by_hash,
        parents_by_hash=parents_by_hash,
        pos_wdl_by_color=pos_wdl_by_color,
    )


def _row_to_finding(
    row: _TransitionRow,
    color_literal: Literal["white", "black"],
    pos_wdl_for_color: dict[int, tuple[int, int, int, datetime.datetime | None]],
    openings_by_hash: dict[int, Opening],
    parents_by_hash: dict[int, Opening],
) -> tuple[OpeningInsightFinding, int, float] | None:
    """Convert one _TransitionRow into a (finding, ply_count, se) tuple, or None.

    Returns None when the row is neutral (classify miss) or when attribution
    fails at every depth (D-34 drop). Mirrors the inner-loop body of the
    original compute_insights pipeline byte-for-byte.
    """
    # Phase 80.1 D-03: feed _classify_row / _compute_score /
    # compute_confidence_bucket / wilson_bounds / OpeningInsightFinding
    # the resulting-position W/D/L via a SimpleNamespace adapter so
    # those helpers stay byte-identical. Non-WDL fields (move_san,
    # entry_*, resulting_full_hash) come from the typed _TransitionRow.
    pos = pos_wdl_for_color.get(row.resulting_full_hash)
    if pos is None:
        # Filter mismatch defensive fallback (RESEARCH.md Pitfall 4).
        # Should not fire when query_resulting_position_wdl filters
        # mirror query_opening_transitions; logged for diagnosis.
        logger.warning(
            "query_resulting_position_wdl missing resulting_full_hash=%s; "
            "falling back to move-played WDL",
            row.resulting_full_hash,
        )
        pos_row: Any = row
        # Fall back to the move-played MAX(played_at) from
        # query_opening_transitions (still the same user, same
        # filters) rather than dropping the line silently.
        finding_last_played_at: datetime.datetime | None = row.last_played_at
    else:
        pos_w, pos_d, pos_l, pos_last_played_at = pos
        pos_n = pos_w + pos_d + pos_l
        pos_row = SimpleNamespace(w=pos_w, d=pos_d, l=pos_l, n=pos_n)
        finding_last_played_at = pos_last_played_at

    cls = _classify_row(pos_row)
    if cls is None:
        return None
    classification, severity = cls

    # BLOCKER-1: single attribution path. None => DROP per D-34.
    attribution = _attribute_finding(row, openings_by_hash, parents_by_hash, color_literal)
    if attribution is None:
        sentry_sdk.set_tag("openings.attribution.unmatched_dropped", True)
        return None
    opening_name, opening_eco, display_name = attribution

    # BLOCKER-1 / D-25: entry_fen reconstructed by replaying the SAN sequence.
    # entry_san_sequence is already a list[str] on _TransitionRow; no None coercion needed.
    # ply=0 entries have [] and legitimately replay zero moves → starting FEN.
    entry_fen = _replay_san_sequence(row.entry_san_sequence)

    # Carry the matched Opening.ply_count alongside for D-24
    # deeper-entry-wins dedupe; use 0 for parent-only matches
    # (parent-matched entries have lower specificity than direct matches).
    # ply=0 entries attribute via resulting_full_hash, so mirror
    # that lookup here to avoid under-counting their depth.
    matched_opening = openings_by_hash.get(row.entry_hash)
    if matched_opening is None and not row.entry_san_sequence:
        matched_opening = openings_by_hash.get(row.resulting_full_hash)
    opening_ply_count = matched_opening.ply_count if matched_opening else 0

    score = _compute_score(pos_row)
    confidence, p_value, se = compute_confidence_bucket(pos_row.w, pos_row.d, pos_row.l, pos_row.n)
    ci_low, ci_high = wilson_bounds(score, pos_row.n)

    finding = OpeningInsightFinding(
        color=color_literal,
        classification=classification,
        severity=severity,
        opening_name=opening_name,
        opening_eco=opening_eco,
        display_name=display_name,
        entry_fen=entry_fen,
        # Phase 71 (D-13): SAN sequence start→entry; empty for entry_ply=0 (no preceding moves).
        entry_san_sequence=row.entry_san_sequence,
        # BLOCKER-5 / Pitfall 1: stringify 64-bit ints at the API boundary.
        entry_full_hash=str(row.entry_hash),
        candidate_move_san=row.move_san,
        resulting_full_hash=str(row.resulting_full_hash),
        n_games=pos_row.n,
        wins=pos_row.w,
        draws=pos_row.d,
        losses=pos_row.l,
        score=score,
        confidence=confidence,
        p_value=p_value,
        ci_low=ci_low,
        ci_high=ci_high,
        # Quick task 260508-r61: MAX(played_at) across all games
        # visiting the resulting position (transposition-inclusive,
        # color-filtered). Falls back to the move-played MAX from
        # query_opening_transitions when the resulting-position
        # lookup misses (matches the W/D/L fallback above).
        last_played_at=finding_last_played_at,
    )
    return finding, opening_ply_count, se


async def _build_sections(
    session: AsyncSession,
    user_id: int,
    request: OpeningInsightsRequest,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    colors_to_query: Sequence[Literal["white", "black"]],
    ctx: _PipelineContext,
) -> dict[str, list[OpeningInsightFinding]]:
    """Stage 3: classify → attribute → assemble → dedupe → rank → cap → enrich.

    Builds the four sections (white/black × weaknesses/strengths), runs
    per-section transposition dedupe (D-24) and global continuation dedupe
    (Phase 71 UAT fix), ranks each section by Wilson 95% CI bound, caps per
    D-02, then enriches surviving findings with MG-entry eval metrics
    (sequential per-color batch awaits per CLAUDE.md AsyncSession rule).
    """
    # ---- Build sections ----
    # Each section accumulates (OpeningInsightFinding, ply_count, se) tuples:
    # - ply_count drives the D-24 deeper-entry-wins dedupe in _dedupe_within_section
    #   (consumed there and not propagated downstream).
    # - se threads through dedupe stages but is ignored by _rank_section under
    #   the Wilson 95% CI bound (quick task 260428-v9i — replaces Wald to fix
    #   small-N degeneracy). SE is still produced for the UI confidence badge.
    sections: dict[str, list[tuple[OpeningInsightFinding, int, float]]] = {
        "white_weaknesses": [],
        "black_weaknesses": [],
        "white_strengths": [],
        "black_strengths": [],
    }

    for color in colors_to_query:
        color_literal: Literal["white", "black"] = color
        for row in ctx.rows_by_color[color]:
            built = _row_to_finding(
                row,
                color_literal,
                ctx.pos_wdl_by_color[color_literal],
                ctx.openings_by_hash,
                ctx.parents_by_hash,
            )
            if built is None:
                continue
            finding, opening_ply_count, se = built
            section_key = (
                f"{color}_{'weaknesses' if finding.classification == 'weakness' else 'strengths'}"
            )
            sections[section_key].append((finding, opening_ply_count, se))

    # Per-section transposition dedupe (D-24) → global continuation dedupe
    # (Phase 71 UAT fix) → rank → cap (D-02 caps: 5 weaknesses, 3 strengths).
    # Quick 260428-v9i: ranks by Wilson 95% CI bound (direction-aware),
    # using (score, n_games) and ignoring SE — replaces the earlier Wald
    # CI to fix small-N degeneracy. Confidence bucket is no longer part of
    # the sort key, only a UI badge.
    deduped_sections: dict[str, list[tuple[OpeningInsightFinding, float]]] = {
        key: _dedupe_within_section(items) for key, items in sections.items()
    }
    deduped_sections = _dedupe_continuations(deduped_sections)
    final_sections: dict[str, list[OpeningInsightFinding]] = {}
    for key, findings_with_se in deduped_sections.items():
        direction: Literal["weakness", "strength"] = (
            "weakness" if "weaknesses" in key else "strength"
        )
        ranked = _rank_section(findings_with_se, direction=direction)
        cap = WEAKNESS_CAP_PER_COLOR if "weaknesses" in key else STRENGTH_CAP_PER_COLOR
        final_sections[key] = ranked[:cap]

    # Populate MG-entry eval fields on all surviving findings.
    # Call the shared batch helper once per color (sequential per CLAUDE.md
    # AsyncSession rule). Key is resulting_full_hash (the position immediately
    # after the candidate move) — mirrors how Stats keys MG-entry eval.
    all_white_findings: list[OpeningInsightFinding] = (
        final_sections["white_weaknesses"] + final_sections["white_strengths"]
    )
    all_black_findings: list[OpeningInsightFinding] = (
        final_sections["black_weaknesses"] + final_sections["black_strengths"]
    )

    white_hashes: list[int] = list({int(f.resulting_full_hash) for f in all_white_findings})
    black_hashes: list[int] = list({int(f.resulting_full_hash) for f in all_black_findings})

    # Sequential awaits — AsyncSession not safe for concurrent use.
    white_eval_metrics: dict[int, OpeningPhaseEntryMetrics] = {}
    if white_hashes:
        white_eval_metrics = await query_opening_phase_entry_metrics_batch(
            session=session,
            user_id=user_id,
            hashes=white_hashes,
            color="white",
            time_control=request.time_control,
            platform=request.platform,
            rated=request.rated,
            opponent_type=request.opponent_type,
            from_date=from_date,
            to_date=to_date,
            opponent_gap_min=request.opponent_gap_min,
            opponent_gap_max=request.opponent_gap_max,
        )

    black_eval_metrics: dict[int, OpeningPhaseEntryMetrics] = {}
    if black_hashes:
        black_eval_metrics = await query_opening_phase_entry_metrics_batch(
            session=session,
            user_id=user_id,
            hashes=black_hashes,
            color="black",
            time_control=request.time_control,
            platform=request.platform,
            rated=request.rated,
            opponent_type=request.opponent_type,
            from_date=from_date,
            to_date=to_date,
            opponent_gap_min=request.opponent_gap_min,
            opponent_gap_max=request.opponent_gap_max,
        )

    return {
        "white_weaknesses": _enrich_findings(
            final_sections["white_weaknesses"], white_eval_metrics
        ),
        "black_weaknesses": _enrich_findings(
            final_sections["black_weaknesses"], black_eval_metrics
        ),
        "white_strengths": _enrich_findings(final_sections["white_strengths"], white_eval_metrics),
        "black_strengths": _enrich_findings(final_sections["black_strengths"], black_eval_metrics),
    }


def _enrich_findings(
    findings: Sequence[OpeningInsightFinding],
    metrics_map: dict[int, OpeningPhaseEntryMetrics],
) -> list[OpeningInsightFinding]:
    """Apply MG-entry eval metrics to each finding when present in metrics_map."""
    result: list[OpeningInsightFinding] = []
    for f in findings:
        pe = metrics_map.get(int(f.resulting_full_hash))
        if pe is not None:
            result.append(_apply_eval_metrics_to_finding(f, pe))
        else:
            result.append(f)
    return result


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def compute_insights(
    session: AsyncSession,
    user_id: int,
    request: OpeningInsightsRequest,
) -> OpeningInsightsResponse:
    """Compute four-section opening insights for one user under a filter set.

    Returns OpeningInsightsResponse with white_weaknesses, black_weaknesses,
    white_strengths, black_strengths — each capped per CONTEXT.md D-08.
    See module docstring for pipeline details.
    """
    from_date: datetime.date | None = request.from_date
    to_date: datetime.date | None = request.to_date

    # D-12 optimization: when the user narrows to a single color, skip the
    # off-color SQL query entirely (~50% latency saving).
    colors_to_query: list[Literal["white", "black"]]
    if request.color == "all":
        colors_to_query = ["white", "black"]
    else:
        colors_to_query = [request.color]

    # WARN-1: the full pipeline (queries + classify + attribute + dedupe +
    # rank + cap) is wrapped in a single try/except so any exception in
    # pure-Python stages also gets the Sentry context + tags.
    try:
        attribution_ctx = await _collect_attribution_hashes(
            session, user_id, request, from_date, to_date, colors_to_query
        )
        pipeline_ctx = await _fetch_position_wdl_per_color(
            session, user_id, request, from_date, to_date, colors_to_query, attribution_ctx
        )
        final_sections = await _build_sections(
            session, user_id, request, from_date, to_date, colors_to_query, pipeline_ctx
        )
        return OpeningInsightsResponse(
            white_weaknesses=final_sections["white_weaknesses"],
            black_weaknesses=final_sections["black_weaknesses"],
            white_strengths=final_sections["white_strengths"],
            black_strengths=final_sections["black_strengths"],
            eval_baseline_pawns_white=EVAL_BASELINE_PAWNS_WHITE,
            eval_baseline_pawns_black=EVAL_BASELINE_PAWNS_BLACK,
        )
    except Exception as exc:
        # CLAUDE.md §Sentry: pass variable data via set_context; never embed
        # user_id or request values in the error message (preserves grouping).
        sentry_sdk.set_context(
            "opening_insights",
            {"user_id": user_id, "request": request.model_dump()},
        )
        sentry_sdk.capture_exception(exc)
        raise
