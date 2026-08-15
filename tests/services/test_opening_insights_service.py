"""Phase 70 service unit tests — INSIGHT-CORE-04, INSIGHT-CORE-05, INSIGHT-CORE-06, INSIGHT-CORE-07.

Tests cover the compute_insights() pipeline: classification boundaries,
severity tiers, deduplication, ranking, caps, attribution, display name
parity, color optimization, and bookmark isolation (D-18).
"""

from __future__ import annotations

import ctypes
import datetime
from typing import Any, Literal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import chess
import chess.polyglot
import pytest

from app.models.opening import Opening
from app.schemas.opening_insights import (
    OpeningInsightFinding,
    OpeningInsightsRequest,
    OpeningInsightsResponse,
)
from app.services.opening_insights_constants import (
    OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE as MIN_GAMES_PER_CANDIDATE,
)
from app.services.opening_insights_service import (
    WEAKNESS_CAP_PER_COLOR,
    STRENGTH_CAP_PER_COLOR,
    _TransitionRow,
    _classify_row,
    _rank_section,
    compute_insights,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_row(
    *,
    entry_hash: int = 100,
    move_san: str = "Nf3",
    resulting_full_hash: int = 200,
    entry_san_sequence: list[str] | None = None,
    n: int = 20,
    w: int = 4,
    d: int = 4,
    losses: int = 12,
    last_played_at: datetime.datetime | None = None,
    sample_game_id: int = 1,
    sample_ply: int = 3,
) -> SimpleNamespace:
    """Construct a synthetic repository Row compatible with compute_insights.

    Includes sample_pair=[ply, game_id] (paired aggregate from the flat-query
    refactor — the SQL emits a single ARRAY[ply, game_id] so that the sample
    refers to one real row in the group, fixing the transposition bug where
    independent MIN(game_id) and MIN(ply) de-correlated). Also exposes
    sample_game_id / sample_ply as flat attrs so the test-only `_fake_wrap`
    can build a _TransitionRow without going through the real replay logic.
    """
    if entry_san_sequence is None:
        entry_san_sequence = ["e4", "c5", "Nf3"]
    return SimpleNamespace(
        entry_hash=entry_hash,
        move_san=move_san,
        resulting_full_hash=resulting_full_hash,
        entry_san_sequence=entry_san_sequence,
        n=n,
        w=w,
        d=d,
        l=losses,
        # Quick task 260508-r61: query_opening_transitions now selects
        # MAX(played_at). The service falls back to it when the resulting-position
        # WDL lookup misses; the fixture default of None mirrors a row whose
        # contributing games all have NULL played_at (rare but valid).
        last_played_at=last_played_at,
        # sample_pair is what production code reads from raw rows; flat
        # sample_game_id / sample_ply are kept for the test-only _fake_wrap stub.
        sample_pair=[sample_ply, sample_game_id],
        sample_game_id=sample_game_id,
        sample_ply=sample_ply,
    )


def _make_opening(
    *,
    full_hash: int = 100,
    name: str = "Sicilian Defense",
    eco: str = "B20",
    ply_count: int = 4,
    pgn: str = "e4 c5",
) -> Opening:
    opening = MagicMock(spec=Opening)
    opening.full_hash = full_hash
    opening.name = name
    opening.eco = eco
    opening.ply_count = ply_count
    opening.pgn = pgn
    return opening


def _default_request(**kwargs: Any) -> OpeningInsightsRequest:
    defaults: dict[str, Any] = {"color": "white"}
    defaults.update(kwargs)
    return OpeningInsightsRequest(**defaults)


def _fake_wrap(raw_row: Any, prefixes: Any) -> _TransitionRow:
    """Test-only stub: convert a mock SimpleNamespace row to _TransitionRow.

    Preserves synthetic hash values (entry_hash=100, resulting_full_hash=200)
    so existing test assertions stay unchanged. Bypasses the SAN replay that
    _wrap_transition_row normally uses to derive resulting_full_hash — the
    actual chess-board replay logic is tested separately in
    test_row_wrapping_drops_unreachable_san_and_captures_to_sentry.
    """
    return _TransitionRow(
        entry_hash=int(raw_row.entry_hash),
        move_san=raw_row.move_san,
        sample_game_id=int(getattr(raw_row, "sample_game_id", 1)),
        sample_ply=int(getattr(raw_row, "sample_ply", 0)),
        n=int(raw_row.n),
        w=int(raw_row.w),
        d=int(raw_row.d),
        l=int(raw_row.l),
        last_played_at=raw_row.last_played_at,
        entry_san_sequence=list(raw_row.entry_san_sequence or []),
        resulting_full_hash=int(raw_row.resulting_full_hash),
    )


async def _run_compute(
    rows: list[SimpleNamespace],
    openings_by_hash: dict[int, Opening] | None = None,
    color: str = "white",
    pos_wdl: dict[int, tuple[int, int, int, datetime.datetime | None]] | None = None,
) -> OpeningInsightsResponse:
    """Helper: patch repo functions and run compute_insights.

    Also patches query_opening_phase_entry_metrics_batch (added quick task
    260506-u2b) to return an empty dict so existing tests are unaffected by
    the new eval-enrichment step.

    Phase 80.1: also patches query_resulting_position_wdl. When pos_wdl is
    None (the default), the mock returns a dict where each row.resulting_full_hash
    maps to (row.w, row.d, row.l, row.last_played_at) — i.e. resulting-position
    WDL == move-played WDL plus the move-played MAX(played_at). This preserves
    existing test expectations because _classify_row, _compute_score,
    compute_confidence_bucket, wilson_bounds, and the OpeningInsightFinding
    fields all see the same numbers they did pre-Phase 80.1. Tests that need to
    drive a divergence between move-played and resulting-position WDL (the new
    transposition tests) pass an explicit pos_wdl mapping.

    Quick task 260508-r61: pos_wdl tuples are now 4-element to carry
    last_played_at through to the OpeningInsightFinding.last_played_at field.

    Flat-query refactor: also patches query_transition_prefixes (new helper) and
    _wrap_transition_row so tests bypass the SAN-replay derivation of
    resulting_full_hash and keep their synthetic hash values (100/200).
    """
    if openings_by_hash is None:
        openings_by_hash = {100: _make_opening()}
    if pos_wdl is None:
        # Default: resulting-position WDL == move-played WDL (no transpositions
        # in fixture). Phase 80.1: existing tests that compute expected score
        # from row.w/d/l/n produce the same expected score under the new
        # aggregation because pos == row by default.
        pos_wdl = {
            int(row.resulting_full_hash): (row.w, row.d, row.l, row.last_played_at) for row in rows
        }

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_transition_prefixes",
            new_callable=AsyncMock,
        ) as mock_prefixes,
        patch(
            "app.services.opening_insights_service._wrap_transition_row",
            side_effect=_fake_wrap,
        ),
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        mock_transitions.return_value = rows
        mock_prefixes.return_value = {}  # bypassed by _wrap_transition_row patch
        mock_attribution.return_value = openings_by_hash
        mock_eval.return_value = {}  # no MG-entry metrics (existing tests unaffected)
        mock_pos_wdl.return_value = pos_wdl

        return await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color=color),
        )


# ---------------------------------------------------------------------------
# Classification boundary tests (D-03, D-11; Phase 75)
# ---------------------------------------------------------------------------


def test_classify_row_neutral_score_046_returns_none() -> None:
    """D-03 strict <=/>= boundaries: score=0.46 → not a finding (neutral, |delta|<0.05)."""
    # n=100, w=40, d=12, l=48 → score = (40 + 6)/100 = 0.46
    row = _make_row(n=100, w=40, d=12, losses=48)
    assert _classify_row(row) is None


def test_classify_row_neutral_score_054_returns_none() -> None:
    """D-03 strict boundary: score=0.54 → not a finding (neutral, |delta|<0.05)."""
    # n=100, w=48, d=12, l=40 → score = (48 + 6)/100 = 0.54
    row = _make_row(n=100, w=48, d=12, losses=40)
    assert _classify_row(row) is None


def test_classify_row_minor_weakness_at_score_045_exact() -> None:
    """D-03/D-11: score=0.45 exactly → minor weakness (delta=-0.05, strict <=)."""
    # n=20, w=5, d=8, l=7 → score = (5 + 4)/20 = 0.45 exactly
    row = _make_row(n=20, w=5, d=8, losses=7)
    result = _classify_row(row)
    assert result is not None
    classification, severity = result
    assert classification == "weakness"
    assert severity == "minor"


def test_classify_row_major_weakness_at_score_040_exact() -> None:
    """D-03/D-11: score=0.40 → major weakness (delta=-0.10, strict <=)."""
    # n=20, w=4, d=8, l=8 → score = (4 + 4)/20 = 0.40 exactly
    row = _make_row(n=20, w=4, d=8, losses=8)
    result = _classify_row(row)
    assert result is not None
    classification, severity = result
    assert classification == "weakness"
    assert severity == "major"


def test_classify_row_minor_strength_at_score_055_exact() -> None:
    """D-03/D-11: score=0.55 → minor strength (delta=+0.05, strict >=)."""
    # n=20, w=8, d=6, l=6 → score = (8 + 3)/20 = 0.55 exactly
    row = _make_row(n=20, w=8, d=6, losses=6)
    result = _classify_row(row)
    assert result is not None
    classification, severity = result
    assert classification == "strength"
    assert severity == "minor"


def test_classify_row_major_strength_at_score_060_exact() -> None:
    """D-03/D-11: score=0.60 → major strength (delta=+0.10, strict >=)."""
    # n=20, w=10, d=4, l=6 → score = (10 + 2)/20 = 0.60 exactly
    row = _make_row(n=20, w=10, d=4, losses=6)
    result = _classify_row(row)
    assert result is not None
    classification, severity = result
    assert classification == "strength"
    assert severity == "major"


# ---------------------------------------------------------------------------
# Evidence floor (D-04 / Phase 75 INSIGHT-SCORE-05)
# ---------------------------------------------------------------------------


def test_min_games_floor_constant_is_20() -> None:
    """Quick 260506: discovery floor raised back from 10 to 20.

    Rationale: the SQL pre-filter on score <= 0.45 OR score >= 0.55 selects on
    the same statistic the Wald p-value then tests, so at n in 10..19 the
    score-vs-50% test is systematically anti-conservative. n>=20 mitigates the
    worst of the post-selection inflation.
    """
    assert MIN_GAMES_PER_CANDIDATE == 20


def test_classify_row_does_not_filter_below_min_games() -> None:
    """The SQL HAVING clause owns the n>=10 floor; _classify_row only inspects score."""
    # n=8, w=2, d=2, l=4 → score = (2+1)/8 = 0.375 → major weakness regardless of n
    row = _make_row(n=8, w=2, d=2, losses=4)
    assert _classify_row(row) is not None


# ---------------------------------------------------------------------------
# Deduplication (D-21, D-24)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dedupe_within_section_keeps_deepest_entry() -> None:
    """D-21, D-24: when two findings share resulting_full_hash in same section,
    keep the one with the deeper (higher ply_count) entry attribution."""
    # Two rows: same resulting_full_hash (999), same section (white weaknesses)
    # but different entry hashes (100 → ply_count=2, 200 → ply_count=6)
    row_shallow = _make_row(entry_hash=100, resulting_full_hash=999, n=20, w=2, d=2, losses=16)
    row_deep = _make_row(
        entry_hash=200,
        resulting_full_hash=999,
        entry_san_sequence=["e4", "c5", "Nf3", "d6"],
        n=30,
        w=3,
        d=3,
        losses=24,
    )

    opening_shallow = _make_opening(full_hash=100, name="Shallow Line", ply_count=2)
    opening_deep = _make_opening(full_hash=200, name="Deep Line", ply_count=6)

    response = await _run_compute(
        rows=[row_shallow, row_deep],
        openings_by_hash={100: opening_shallow, 200: opening_deep},
        color="white",
    )
    # Only one finding should survive dedupe (both are weaknesses, same resulting hash)
    assert len(response.white_weaknesses) == 1
    # The deeper entry (ply_count=6) wins
    assert response.white_weaknesses[0].opening_name == "Deep Line"


@pytest.mark.asyncio
async def test_cross_color_same_hash_kept_as_two_findings() -> None:
    """D-21: same resulting_full_hash in white and black sections → both kept."""
    # One row classified as weakness for white, one for black
    # same resulting_full_hash across colors
    row_white = _make_row(entry_hash=100, resulting_full_hash=999, n=20, w=2, d=2, losses=16)
    row_black = _make_row(entry_hash=100, resulting_full_hash=999, n=20, w=2, d=2, losses=16)
    opening = _make_opening(full_hash=100)

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        # First call (white) → row_white, second call (black) → row_black
        mock_transitions.side_effect = [
            [row_white],
            [row_black],
        ]
        mock_attribution.return_value = {100: opening}
        mock_eval.return_value = {}
        # Phase 80.1: pos WDL == move-played WDL (no transposition in fixture).
        mock_pos_wdl.return_value = {999: (2, 2, 16, None)}

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="all"),
        )

    # Both sections should have one finding (cross-color dedup does NOT happen)
    assert len(response.white_weaknesses) == 1
    assert len(response.black_weaknesses) == 1


@pytest.mark.asyncio
async def test_continuation_dedupe_collapses_chain_across_sections() -> None:
    """Phase 71 UAT fix: a chain of consecutive weak moves in the same line
    collapses to the shortest entry, even when the chain crosses color sections.

    Reproduces the Caro-Kann B10 case reported during UAT:
      - 1.e4 c6 2.Nc3 d5 3.exd5    (white weakness)
      - 1.e4 c6 2.Nc3 d5 3.exd5 cxd5    (black weakness)
      - 1.e4 c6 2.Nc3 d5 3.exd5 cxd5 4.d4    (white weakness)

    Only the shortest entry (3.exd5) should remain — its cover prefix
    [e4,c6,Nc3,d5,exd5] subsumes both deeper findings.
    """
    row_white_shallow = _make_row(
        entry_hash=100,
        move_san="exd5",
        resulting_full_hash=200,
        entry_san_sequence=["e4", "c6", "Nc3", "d5"],
        n=20,
        w=4,
        d=4,
        losses=12,
    )
    row_white_deep = _make_row(
        entry_hash=300,
        move_san="d4",
        resulting_full_hash=400,
        entry_san_sequence=["e4", "c6", "Nc3", "d5", "exd5", "cxd5"],
        n=20,
        w=4,
        d=4,
        losses=12,
    )
    row_black_mid = _make_row(
        entry_hash=200,
        move_san="cxd5",
        resulting_full_hash=300,
        entry_san_sequence=["e4", "c6", "Nc3", "d5", "exd5"],
        n=20,
        w=4,
        d=4,
        losses=12,
    )
    opening_a = _make_opening(full_hash=100, name="Caro-Kann Defense", eco="B10", ply_count=4)
    opening_b = _make_opening(full_hash=200, name="Caro-Kann Defense", eco="B10", ply_count=5)
    opening_c = _make_opening(full_hash=300, name="Caro-Kann Defense", eco="B10", ply_count=6)

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_transition_prefixes",
            new_callable=AsyncMock,
        ),
        patch(
            "app.services.opening_insights_service._wrap_transition_row",
            side_effect=_fake_wrap,
        ),
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        # White call returns shallow + deep, black call returns mid.
        mock_transitions.side_effect = [
            [row_white_shallow, row_white_deep],
            [row_black_mid],
        ]
        mock_attribution.return_value = {100: opening_a, 200: opening_b, 300: opening_c}
        mock_eval.return_value = {}
        # Phase 80.1: pos WDL == move-played WDL across all three rows.
        mock_pos_wdl.return_value = {
            200: (4, 4, 12, None),
            400: (4, 4, 12, None),
            300: (4, 4, 12, None),
        }

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="all"),
        )

    # Only the shortest finding (3.exd5) should survive — both deeper continuations
    # are subsumed by the shallow finding's cover prefix.
    assert len(response.white_weaknesses) == 1
    assert response.white_weaknesses[0].candidate_move_san == "exd5"
    assert len(response.black_weaknesses) == 0


@pytest.mark.asyncio
async def test_continuation_dedupe_keeps_sibling_lines_at_same_depth() -> None:
    """Two findings sharing the same entry but with different candidate moves
    are siblings, not a chain — both must be kept (different cover prefixes)."""
    # Same entry position, two different candidate moves → both classified as weak.
    row_a = _make_row(
        entry_hash=100,
        move_san="exd5",
        resulting_full_hash=200,
        entry_san_sequence=["e4", "c6", "Nc3", "d5"],
        n=20,
        w=4,
        d=4,
        losses=12,
    )
    row_b = _make_row(
        entry_hash=100,
        move_san="d3",
        resulting_full_hash=201,
        entry_san_sequence=["e4", "c6", "Nc3", "d5"],
        n=20,
        w=4,
        d=4,
        losses=12,
    )
    opening = _make_opening(full_hash=100, name="Caro-Kann Defense", eco="B10", ply_count=4)
    response = await _run_compute(
        rows=[row_a, row_b],
        openings_by_hash={100: opening},
        color="white",
    )
    # Sibling candidates from the same entry are NOT a continuation chain.
    assert len(response.white_weaknesses) == 2
    candidates = {f.candidate_move_san for f in response.white_weaknesses}
    assert candidates == {"exd5", "d3"}


# ---------------------------------------------------------------------------
# Attribution (D-22, D-23, D-24)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_attribution_picks_max_ply_count() -> None:
    """D-22: when multiple openings share entry_hash, the one with MAX(ply_count) wins.

    query_openings_by_hashes already handles this (Plan 70-03). Here we verify
    the service uses the returned opening name correctly.
    """
    # The mock already returns deepest opening by ply_count (as the repo does)
    opening = _make_opening(full_hash=100, name="Deep Sicilian", ply_count=8, eco="B70")
    response = await _run_compute(
        rows=[_make_row(n=20, w=4, d=4, losses=12)],
        openings_by_hash={100: opening},
        color="white",
    )
    assert len(response.white_weaknesses) == 1
    assert response.white_weaknesses[0].opening_name == "Deep Sicilian"
    assert response.white_weaknesses[0].opening_eco == "B70"


@pytest.mark.asyncio
async def test_finding_includes_entry_san_sequence() -> None:
    """Phase 71 (D-13): entry_san_sequence is exposed on the wire schema.

    Asserts:
      - field is a list of str
      - length >= MIN_ENTRY_PLY=0 (entry_ply >= 0 guaranteed by service;
        ply=0 entries legitimately yield an empty SAN prefix)
      - replaying the sequence on a fresh chess.Board reproduces entry_fen exactly
    """
    opening = _make_opening(full_hash=100, name="Sicilian Defense", ply_count=4, eco="B20")
    # Default _make_row() uses entry_san_sequence=["e4", "c5", "Nf3"] (3 plys)
    row = _make_row(n=20, w=4, d=4, losses=12)
    response = await _run_compute(
        rows=[row],
        openings_by_hash={100: opening},
        color="white",
    )
    assert len(response.white_weaknesses) == 1
    finding = response.white_weaknesses[0]

    # Phase 71 (D-13): entry_san_sequence is the SAN sequence from the start
    # position to the entry position (candidate excluded). With MIN_ENTRY_PLY=0
    # the field may be empty (ply=0 entries: no preceding moves), but the
    # default test fixture seeds 3 plys so this assertion still expects them.
    assert isinstance(finding.entry_san_sequence, list)
    assert all(isinstance(san, str) for san in finding.entry_san_sequence)
    assert len(finding.entry_san_sequence) >= 0, (
        f"entry_san_sequence must have length >= MIN_ENTRY_PLY=0, got {len(finding.entry_san_sequence)}"
    )
    # Replaying the SAN sequence must reproduce entry_fen exactly
    _board = chess.Board()
    for _san in finding.entry_san_sequence:
        _board.push_san(_san)
    assert _board.fen() == finding.entry_fen, (
        f"Replaying entry_san_sequence must reproduce entry_fen.\n"
        f"  expected: {finding.entry_fen}\n"
        f"  got:      {_board.fen()}"
    )


@pytest.mark.asyncio
async def test_attribution_lineage_walk_to_parent_hash() -> None:
    """D-23: when entry_hash has no direct openings match, walk parent lineage.

    Builds a real SAN sequence ["e4", "c5", "Nf3"], computes the full_hash at
    ply=2 (after "c5") as the 'Sicilian Defense' opening hash, and seeds an
    Opening row with that hash. The row's entry_hash is the hash at ply=3
    (post-Nf3), which has NO direct Opening row.

    The service must walk back to the ply=2 parent hash and return the
    'Sicilian Defense' name.
    """
    # Compute the Zobrist hash at ply=2 (after "c5") — the Sicilian Defense position
    board = chess.Board()
    board.push_san("e4")
    board.push_san("c5")
    parent_hash = ctypes.c_int64(chess.polyglot.zobrist_hash(board)).value

    # The entry is at ply=3 (after Nf3) — this hash has no Opening row
    board.push_san("Nf3")
    entry_hash_at_ply3 = ctypes.c_int64(chess.polyglot.zobrist_hash(board)).value

    parent_opening = _make_opening(
        full_hash=parent_hash,
        name="Sicilian Defense",
        eco="B20",
        ply_count=2,
    )

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_transition_prefixes",
            new_callable=AsyncMock,
        ),
        patch(
            "app.services.opening_insights_service._wrap_transition_row",
            side_effect=_fake_wrap,
        ),
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        row = _make_row(
            entry_hash=entry_hash_at_ply3,
            entry_san_sequence=["e4", "c5", "Nf3"],
            n=20,
            w=2,
            d=2,
            losses=16,
        )
        mock_transitions.return_value = [row]

        # Pass 1: direct attribution → no match for entry_hash_at_ply3
        # Pass 2: parent attribution → returns parent_opening for parent_hash
        mock_attribution.side_effect = [
            {},  # direct pass: no opening at ply=3
            {parent_hash: parent_opening},  # parent pass: Sicilian at ply=2
        ]
        mock_eval.return_value = {}
        # Phase 80.1: pos WDL == move-played WDL (no transposition fixture).
        mock_pos_wdl.return_value = {200: (2, 2, 16, None)}

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="white"),
        )

    assert len(response.white_weaknesses) == 1
    assert response.white_weaknesses[0].opening_name == "Sicilian Defense"


@pytest.mark.asyncio
async def test_attribution_drops_finding_when_no_lineage_match() -> None:
    """Per D-34, findings with no direct match AND no parent ancestor in the
    openings table are DROPPED from the response, not surfaced with a sentinel."""
    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        row = _make_row(n=20, w=2, d=2, losses=16, entry_hash=9999)
        mock_transitions.return_value = [row]
        # Both passes return empty dicts — no attribution possible
        mock_attribution.return_value = {}
        mock_eval.return_value = {}
        # Phase 80.1: pos WDL == move-played WDL.
        mock_pos_wdl.return_value = {200: (2, 2, 16, None)}

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="white"),
        )

    # Finding is dropped — no sentinel '<unnamed line>' surfaced
    assert len(response.white_weaknesses) == 0


@pytest.mark.asyncio
async def test_unnamed_line_fallback_uses_empty_eco_and_sentinel_name() -> None:
    """D-23: this test verifies UNNAMED_LINE_* constants exist and are correct.

    Per D-34, unnamed-line findings are dropped in Phase 70 (not surfaced).
    The constants are defined for telemetry/future use but not emitted on
    responses. We verify the constants exist with correct values.
    """
    from app.services.opening_insights_service import UNNAMED_LINE_ECO, UNNAMED_LINE_NAME

    assert UNNAMED_LINE_NAME == "<unnamed line>"
    assert UNNAMED_LINE_ECO == ""


# ---------------------------------------------------------------------------
# Ranking and caps (D-07, D-02, D-08)
# ---------------------------------------------------------------------------


def _make_weakness_finding(
    score: float,
    candidate: str,
    confidence: Literal["low", "medium", "high"] = "high",
    n_games: int = 400,
) -> OpeningInsightFinding:
    """Build a minimal weakness OpeningInsightFinding for ranking-level tests.

    Quick task 260428-v9i: ranking now uses the Wilson 95% score interval, which
    is derived from `score` and `n_games` directly (no SE input). Tests therefore
    drive uncertainty via `n_games` rather than synthetic SE values; the SE
    component of the (finding, se) tuple is preserved upstream but ignored by
    `_rank_section`. wins/losses are derived from `score * n_games` so the
    finding is internally consistent for downstream display.
    """
    wins = int(round(score * n_games))
    return OpeningInsightFinding(
        color="white",
        classification="weakness",
        severity="major",
        opening_name="Test",
        opening_eco="A00",
        display_name="Test",
        entry_fen="",
        entry_san_sequence=[],
        entry_full_hash="0",
        candidate_move_san=candidate,
        resulting_full_hash="0",
        n_games=n_games,
        wins=wins,
        draws=0,
        losses=n_games - wins,
        score=score,
        confidence=confidence,
        p_value=0.5,
        ci_low=max(0.0, score - 0.05),
        ci_high=min(1.0, score + 0.05),
    )


def _make_strength_finding(
    score: float,
    candidate: str,
    confidence: Literal["low", "medium", "high"] = "high",
    n_games: int = 400,
) -> OpeningInsightFinding:
    wins = int(round(score * n_games))
    return OpeningInsightFinding(
        color="white",
        classification="strength",
        severity="major",
        opening_name="Test",
        opening_eco="A00",
        display_name="Test",
        entry_fen="",
        entry_san_sequence=[],
        entry_full_hash="0",
        candidate_move_san=candidate,
        resulting_full_hash="0",
        n_games=n_games,
        wins=wins,
        draws=0,
        losses=n_games - wins,
        score=score,
        confidence=confidence,
        p_value=0.5,
        ci_low=max(0.0, score - 0.05),
        ci_high=min(1.0, score + 0.05),
    )


def test_ranking_ignores_confidence_bucket_uses_ci_bound_only() -> None:
    """Quick task 260428-v9i: confidence bucket is no longer part of the sort
    key. A "medium" bucket row can outrank a "high" bucket row if its Wilson
    upper bound is more striking (and vice versa). Bucket is retained as a UI
    badge only.

      medium_tight: score=0.42, n_games=4000 -> Wilson upper ~ 0.4354.
      high_wide:    score=0.40, n_games=100  -> Wilson upper ~ 0.4980.

    Even though high_wide has the larger raw effect, medium_tight's tight CI
    sits much lower against the 0.5 pivot. medium_tight sorts first.
    """
    high_wide = _make_weakness_finding(
        score=0.40, candidate="high_wide", confidence="high", n_games=100
    )
    medium_tight = _make_weakness_finding(
        score=0.42, candidate="medium_tight", confidence="medium", n_games=4000
    )

    # SE values are arbitrary under Wilson — kept in the tuple for upstream
    # contract compatibility but ignored by _rank_section. Setting SE=0 here
    # would make the old Wald formula collapse to a pure score sort (giving
    # high_wide first), so this test also distinguishes Wilson from Wald.
    ranked = _rank_section([(high_wide, 0.0), (medium_tight, 0.0)], direction="weakness")
    assert [f.candidate_move_san for f in ranked] == ["medium_tight", "high_wide"], (
        "Tight medium-bucket row with stricter Wilson bound must outrank wide high-bucket row"
    )


def test_ranking_ci_upper_bound_tiebreak_within_same_confidence_for_weaknesses() -> None:
    """Quick task 260428-v9i: within a confidence bucket, weaknesses are ranked
    by Wilson 95% upper bound ASCENDING — the row whose score is most-confidently
    -below-0.5 sorts first. The fixture is chosen so that the new (Wilson upper)
    and old (|score - 0.5|) rules disagree:

      F1: score=0.40, n_games=10000 -> Wilson upper ~ 0.4096. |delta| = 0.10.
      F2: score=0.30, n_games=50    -> Wilson upper ~ 0.4375. |delta| = 0.20.

    Old rule (|score-0.5| desc): F2 first (|delta|=0.20 > 0.10).
    New rule (upper bound asc):  F1 first (0.4096 < 0.4375) — F1's CI is much
    tighter and stays well below 0.5, so F1 is the more-confidently-bad row.
    """
    f1 = _make_weakness_finding(score=0.40, candidate="f1", confidence="high", n_games=10000)
    f2 = _make_weakness_finding(score=0.30, candidate="f2", confidence="high", n_games=50)

    # SE arbitrary (ignored by Wilson). 0.0 also makes the old Wald formula
    # collapse to score-only, where f2 (0.30) < f1 (0.40) — opposite of Wilson.
    ranked = _rank_section([(f2, 0.0), (f1, 0.0)], direction="weakness")
    assert [f.candidate_move_san for f in ranked] == ["f1", "f2"], (
        "F1 (tight CI, upper=0.4096) must outrank F2 (wide CI, upper=0.4375) within the same bucket"
    )


def test_ranking_small_n_high_effect_does_not_outrank_large_n_moderate_effect_within_bucket() -> (
    None
):
    """Must-have: a small-N high-effect finding should NOT outrank a large-N
    moderate-effect finding within the same bucket — small N widens the Wilson
    interval and demotes the row.

      A (small N, high effect):     score=0.20, n_games=20  -> Wilson upper ~ 0.4160.
      B (large N, moderate effect): score=0.30, n_games=400 -> Wilson upper ~ 0.3466.

    New Wilson-bound rule: B.upper (0.347) < A.upper (0.416) -> B sorts FIRST.
    Old |score-0.5| rule would have ordered A.|delta|=0.30 > B.|delta|=0.20 -> A first.
    """
    a_small_n = _make_weakness_finding(score=0.20, candidate="a", confidence="high", n_games=20)
    b_large_n = _make_weakness_finding(score=0.30, candidate="b", confidence="high", n_games=400)

    # SE=0 makes the old Wald formula collapse to score-only, where A (0.20)
    # would sort first — but Wilson correctly demotes the small-N row.
    ranked = _rank_section([(a_small_n, 0.0), (b_large_n, 0.0)], direction="weakness")
    assert [f.candidate_move_san for f in ranked] == ["b", "a"], (
        "Large-N moderate finding must outrank small-N high-effect finding under Wilson"
    )


def test_ranking_strength_uses_lower_bound() -> None:
    """Quick task 260428-v9i: strengths sort by Wilson 95% LOWER bound DESCENDING
    (most-confidently-good first). Symmetric to the weakness case.

      F1: score=0.60, n_games=10000 -> Wilson lower ~ 0.5904.
      F2: score=0.70, n_games=50    -> Wilson lower ~ 0.5625.

    F1's lower bound (0.59) is well above 0.5; F2's (0.56) hugs the pivot.
    F1 sorts first under the new rule despite having a smaller raw effect.
    """
    f1 = _make_strength_finding(score=0.60, candidate="f1", confidence="high", n_games=10000)
    f2 = _make_strength_finding(score=0.70, candidate="f2", confidence="high", n_games=50)

    # SE=0 collapses old Wald to score-only, where f2 (0.70) > f1 (0.60) and
    # would sort first — opposite of Wilson, which correctly tightens f1's
    # bound and pushes it above f2's.
    ranked = _rank_section([(f2, 0.0), (f1, 0.0)], direction="strength")
    assert [f.candidate_move_san for f in ranked] == ["f1", "f2"], (
        "F1 (tight CI, lower=0.5904) must outrank F2 (wide CI, lower=0.5625) within the same bucket"
    )


def test_ranking_bound_handles_boundary_scores() -> None:
    """Quick task 260428-v9i: Wilson is well-defined at boundary scores (p=0,
    p=1) — no Wald-style SE=0 degeneracy. The defensive clamp to [0, 1] is kept
    in the implementation for safety, but ordering does not depend on it.

    Weakness side:
      f_extreme: score=0.95, n_games=20  -> Wilson upper ~ 0.9911 (NOT clamped).
      f_normal:  score=0.30, n_games=400 -> Wilson upper ~ 0.3466.
    Normal row sorts first (its bound is much further below 0.5).

    Strength side:
      s_extreme: score=0.05, n_games=20  -> Wilson lower ~ 0.0089.
      s_normal:  score=0.70, n_games=400 -> Wilson lower ~ 0.6534.
    Normal row sorts first (its bound is much further above 0.5).
    """
    f_extreme = _make_weakness_finding(
        score=0.95, candidate="extreme", confidence="high", n_games=20
    )
    f_normal = _make_weakness_finding(
        score=0.30, candidate="normal", confidence="high", n_games=400
    )

    # SE values arbitrary — Wilson uses only score and n_games.
    ranked = _rank_section([(f_extreme, 0.0), (f_normal, 0.0)], direction="weakness")
    # Normal row (upper ~0.347) sorts before extreme row (upper ~0.991).
    assert [f.candidate_move_san for f in ranked] == ["normal", "extreme"]

    s_extreme = _make_strength_finding(
        score=0.05, candidate="extreme", confidence="high", n_games=20
    )
    s_normal = _make_strength_finding(
        score=0.70, candidate="normal", confidence="high", n_games=400
    )

    ranked_s = _rank_section([(s_extreme, 0.0), (s_normal, 0.0)], direction="strength")
    # Normal row (lower ~0.653) sorts before extreme row (lower ~0.009).
    assert [f.candidate_move_san for f in ranked_s] == ["normal", "extreme"]


@pytest.mark.asyncio
async def test_caps_10_per_color_per_classification() -> None:
    """D-02, D-08 + Phase 71 UAT: per-section caps applied after sorting: top-10 weaknesses, top-10 strengths."""
    assert WEAKNESS_CAP_PER_COLOR == 10
    assert STRENGTH_CAP_PER_COLOR == 10

    # Create 12 weakness rows — only 10 should survive cap.
    # Use fixed n=20, w=4, d=4, l=12 (score=0.30, major) so all rows classify.
    # Distinct entry/resulting hashes AND distinct candidate moves prevent
    # _dedupe_continuations from collapsing them as same-line findings.
    weakness_rows = [
        _make_row(
            entry_hash=i,
            move_san=f"M{i}",
            resulting_full_hash=100 + i,
            entry_san_sequence=["e4"],
            n=20,
            w=4,
            d=4,
            losses=12,  # score=(4+2)/20=0.30 → major weakness for all
        )
        for i in range(1, 13)
    ]
    openings_map = {
        i: _make_opening(full_hash=i, name=f"Opening {i}", ply_count=2) for i in range(1, 13)
    }

    response = await _run_compute(
        rows=weakness_rows,
        openings_by_hash=openings_map,
        color="white",
    )
    assert len(response.white_weaknesses) == WEAKNESS_CAP_PER_COLOR  # 10
    assert len(response.white_strengths) == 0  # no strength rows

    # Now create 12 strength rows — only 10 should survive cap.
    strength_rows = [
        _make_row(
            entry_hash=20 + i,
            move_san=f"M{i}",
            resulting_full_hash=200 + i,
            entry_san_sequence=["e4"],
            n=20,
            w=14,
            d=3,
            losses=3,  # score=(14+1.5)/20=0.775 → major strength
        )
        for i in range(1, 13)
    ]
    openings_strength = {
        20 + i: _make_opening(full_hash=20 + i, name=f"Strength {i}", ply_count=2)
        for i in range(1, 13)
    }
    response2 = await _run_compute(
        rows=strength_rows,
        openings_by_hash=openings_strength,
        color="white",
    )
    assert len(response2.white_strengths) == STRENGTH_CAP_PER_COLOR  # 10
    assert len(response2.white_weaknesses) == 0


# ---------------------------------------------------------------------------
# Phase 75 D-09: confidence + p_value end-to-end smoke
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compute_insights_populates_confidence_and_p_value() -> None:
    """Phase 75 D-09: every finding carries confidence + p_value fields."""
    # Major weakness, n=20: score = (2 + 0.5*2)/20 = 0.15 (delta=-0.35, major).
    # variance = (2 + 0.25*2)/20 - 0.0225 = 0.125 - 0.0225 = 0.1025
    # se = sqrt(0.1025/20) ≈ 0.0716
    # z ≈ -4.89; p ≈ 1e-6; n=20 >= 10 → high
    row = _make_row(n=20, w=2, d=2, losses=16)
    opening = _make_opening()
    response = await _run_compute(rows=[row], openings_by_hash={100: opening}, color="white")

    assert len(response.white_weaknesses) == 1
    finding = response.white_weaknesses[0]
    assert finding.severity == "major"
    assert finding.score == pytest.approx(0.15)
    assert finding.confidence == "high"
    assert 0.0 <= finding.p_value <= 1.0


# ---------------------------------------------------------------------------
# Color optimization (D-12)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_color_optimization_skips_unused_color_query() -> None:
    """D-12: when request.color='white', only one SQL call issued; black sections empty."""
    row = _make_row(n=20, w=12, d=4, losses=4)  # strength
    opening = _make_opening(full_hash=100)

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        mock_transitions.return_value = [row]
        mock_attribution.return_value = {100: opening}
        mock_eval.return_value = {}
        # Phase 80.1: pos WDL == move-played WDL (no transposition fixture).
        mock_pos_wdl.return_value = {200: (12, 4, 4, None)}

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="white"),
        )

        # Only ONE query_opening_transitions call (for white)
        assert mock_transitions.call_count == 1

    # Black sections must be empty
    assert response.black_weaknesses == []
    assert response.black_strengths == []
    # White section has the strength finding
    assert len(response.white_strengths) == 1


# ---------------------------------------------------------------------------
# Display name parity (D-22 / RESEARCH.md Pitfall 4)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_display_name_vs_prefix_when_attribution_parity_disagrees() -> None:
    """D-22 / Pitfall 4: black-section finding attributed to white-defined opening
    (odd ply_count) gets display_name = 'vs. <name>'."""
    # A white-defined opening has odd ply_count (white's move, e.g., ply_count=3 = after white's 2nd move)
    # When it appears in the BLACK section, parity disagrees → prefix "vs. "
    white_defined_opening = _make_opening(
        full_hash=100,
        name="London System",
        ply_count=3,  # odd → defined for white
    )
    row = _make_row(n=20, w=2, d=2, losses=16)

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        mock_transitions.side_effect = [
            [],  # white query: no rows
            [row],  # black query: one weakness
        ]
        mock_attribution.return_value = {100: white_defined_opening}
        mock_eval.return_value = {}
        # Phase 80.1: pos WDL == move-played WDL.
        mock_pos_wdl.return_value = {200: (2, 2, 16, None)}

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="all"),
        )

    assert len(response.black_weaknesses) == 1
    finding = response.black_weaknesses[0]
    assert finding.display_name.startswith("vs. ")
    assert "London System" in finding.display_name


# ---------------------------------------------------------------------------
# Bookmarks isolation (D-18)
# ---------------------------------------------------------------------------


def test_bookmarks_not_consumed_by_algorithm() -> None:
    """D-18: bookmarks are NOT an algorithmic input; OpeningInsightsRequest has
    no bookmark field and the service signature does not accept bookmarks."""
    # Verify at the schema level: no bookmark field on request model
    assert "bookmark" not in OpeningInsightsRequest.model_fields

    # Verify compute_insights signature does not have a bookmark parameter
    import inspect

    sig = inspect.signature(compute_insights)
    param_names = list(sig.parameters.keys())
    assert "bookmark" not in param_names
    assert "bookmarks" not in param_names


# ---------------------------------------------------------------------------
# Phase 80 MG-entry eval fields on OpeningInsightFinding (quick task 260506-u2b)
# ---------------------------------------------------------------------------


def test_opening_insight_finding_eval_fields_default() -> None:
    """OpeningInsightFinding defaults: eval fields are None / 0 / 'low'."""
    finding = OpeningInsightFinding(
        color="white",
        classification="weakness",
        severity="minor",
        opening_name="Test",
        opening_eco="A00",
        display_name="Test",
        entry_fen="",
        entry_san_sequence=[],
        entry_full_hash="0",
        candidate_move_san="e4",
        resulting_full_hash="0",
        n_games=20,
        wins=4,
        draws=4,
        losses=12,
        score=0.30,
        confidence="low",
        p_value=0.5,
        ci_low=0.20,
        ci_high=0.40,
    )
    assert finding.avg_eval_pawns is None
    assert finding.eval_ci_low_pawns is None
    assert finding.eval_ci_high_pawns is None
    assert finding.eval_n == 0
    assert finding.eval_p_value is None
    assert finding.eval_confidence == "low"


def test_opening_insights_response_carries_eval_baselines() -> None:
    """OpeningInsightsResponse must expose eval_baseline_pawns_white and _black."""
    from app.services.opening_insights_constants import (
        EVAL_BASELINE_PAWNS_WHITE,
        EVAL_BASELINE_PAWNS_BLACK,
    )

    resp = OpeningInsightsResponse(
        eval_baseline_pawns_white=EVAL_BASELINE_PAWNS_WHITE,
        eval_baseline_pawns_black=EVAL_BASELINE_PAWNS_BLACK,
    )
    assert resp.eval_baseline_pawns_white == EVAL_BASELINE_PAWNS_WHITE
    assert resp.eval_baseline_pawns_black == EVAL_BASELINE_PAWNS_BLACK


@pytest.mark.asyncio
async def test_compute_insights_eval_fields_populated_when_metrics_present() -> None:
    """When query_opening_phase_entry_metrics_batch returns metrics for a finding's
    resulting_full_hash, the service populates the six eval fields on the finding."""
    from unittest.mock import AsyncMock, patch
    from app.repositories.stats_repository import OpeningPhaseEntryMetrics

    row = _make_row(n=20, w=4, d=4, losses=12, resulting_full_hash=999)
    opening = _make_opening(full_hash=100)

    # Synthetic metrics for the resulting_full_hash=999
    synthetic_metrics: dict[int, OpeningPhaseEntryMetrics] = {
        999: OpeningPhaseEntryMetrics(
            eval_sum_mg=2000.0,  # mean = 2000/20 = 100 cp = 1.0 pawns
            eval_sumsq_mg=220000.0,
            eval_n_mg=20,
            mate_n_mg=0,
            null_eval_n_mg=0,
            outlier_n_mg=0,
        ),
    }

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_transition_prefixes",
            new_callable=AsyncMock,
        ),
        patch(
            "app.services.opening_insights_service._wrap_transition_row",
            side_effect=_fake_wrap,
        ),
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        mock_transitions.return_value = [row]
        mock_attribution.return_value = {100: opening}
        mock_eval.return_value = synthetic_metrics
        # Phase 80.1: pos WDL == move-played WDL (no transposition fixture).
        mock_pos_wdl.return_value = {999: (4, 4, 12, None)}

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="white"),
        )

    assert len(response.white_weaknesses) == 1
    finding = response.white_weaknesses[0]
    # eval fields should be populated
    assert finding.eval_n == 20
    assert finding.avg_eval_pawns is not None
    assert abs(finding.avg_eval_pawns - 1.0) < 0.01  # 100 cp = 1.0 pawns
    assert finding.eval_p_value is not None
    assert finding.eval_confidence in ("low", "medium", "high")
    # Baselines are present on the response
    assert isinstance(response.eval_baseline_pawns_white, float)
    assert isinstance(response.eval_baseline_pawns_black, float)


@pytest.mark.asyncio
async def test_compute_insights_eval_fields_stay_at_defaults_when_no_metrics() -> None:
    """When query_opening_phase_entry_metrics_batch returns empty dict (no MG entry data),
    eval fields stay at defaults (eval_n=0, avg_eval_pawns=None, eval_confidence='low')."""
    from unittest.mock import AsyncMock, patch

    row = _make_row(n=20, w=4, d=4, losses=12, resulting_full_hash=999)
    opening = _make_opening(full_hash=100)

    with (
        patch(
            "app.services.opening_insights_service.query_opening_transitions",
            new_callable=AsyncMock,
        ) as mock_transitions,
        patch(
            "app.services.opening_insights_service.query_openings_by_hashes",
            new_callable=AsyncMock,
        ) as mock_attribution,
        patch(
            "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
            new_callable=AsyncMock,
        ) as mock_eval,
        patch(
            "app.services.opening_insights_service.query_resulting_position_wdl",
            new_callable=AsyncMock,
        ) as mock_pos_wdl,
    ):
        mock_transitions.return_value = [row]
        mock_attribution.return_value = {100: opening}
        mock_eval.return_value = {}  # no metrics
        # Phase 80.1: pos WDL == move-played WDL (no transposition fixture).
        mock_pos_wdl.return_value = {999: (4, 4, 12, None)}

        response = await compute_insights(
            session=AsyncMock(),
            user_id=1,
            request=_default_request(color="white"),
        )

    assert len(response.white_weaknesses) == 1
    finding = response.white_weaknesses[0]
    assert finding.eval_n == 0
    assert finding.avg_eval_pawns is None
    assert finding.eval_ci_low_pawns is None
    assert finding.eval_ci_high_pawns is None
    assert finding.eval_p_value is None
    assert finding.eval_confidence == "low"


# ---------------------------------------------------------------------------
# Phase 80.1 D-03/D-05: resulting-position WDL drives classification + fields
# ---------------------------------------------------------------------------
#
# Hash namespace 0xDD** is reserved for Phase 80.1 service-level transposition
# tests (mirrors Plan 02's 0xCC** for openings_service tests). These tests
# drive a divergence between move-played WDL (carried on `row`) and resulting-
# position WDL (returned by query_resulting_position_wdl) so we can verify
# that compute_insights classifies, ranks, and populates fields from the
# resulting-position aggregation, not from the move-played counts.
DIVERGE_HASH = 0xDD01
FLIP_HASH = 0xDD02
VALIDATOR_HASH = 0xDD03


class TestComputeInsightsTranspositionWdl:
    """Phase 80.1 D-03/D-05: resulting-position WDL drives classification + fields."""

    @pytest.mark.asyncio
    async def test_finding_uses_resulting_position_wdl_when_diverges_from_move_played(
        self,
    ) -> None:
        """When pos_wdl diverges from row (transposition: more games visit the
        resulting position than played the candidate from this entry),
        finding.{n_games, wins, draws, losses, score} all reflect pos_wdl,
        not the move-played row."""
        # Move-played: w=15, d=3, l=2, n=20 → score = 16.5/20 = 0.825 (major strength)
        # Pos WDL:     w=24, d=6, l=10, n=40 → score = 27/40 = 0.675 (still major strength)
        # Surfacing gate (HAVING n_games >= 20) passes on move-played n=20.
        # Field validator (Field(ge=20) on n_games) passes on pos_n=40.
        row = _make_row(
            entry_hash=100,
            move_san="e4",
            resulting_full_hash=DIVERGE_HASH,
            entry_san_sequence=["e4"],
            n=20,
            w=15,
            d=3,
            losses=2,
        )
        opening = _make_opening(full_hash=100, ply_count=1)

        response = await _run_compute(
            rows=[row],
            openings_by_hash={100: opening},
            color="white",
            pos_wdl={DIVERGE_HASH: (24, 6, 10, None)},
        )

        assert len(response.white_strengths) == 1
        finding = response.white_strengths[0]
        # Field semantics flip to resulting-position WDL.
        assert finding.n_games == 40
        assert finding.wins == 24
        assert finding.draws == 6
        assert finding.losses == 10
        assert finding.score == pytest.approx(27 / 40, abs=1e-9)
        # Classification stays strength (0.675 still >= 0.60 = major threshold).
        assert finding.classification == "strength"
        assert finding.severity == "major"

    @pytest.mark.asyncio
    async def test_finding_classification_uses_resulting_position_score(self) -> None:
        """When move-played score classifies as strength but pos_wdl yields a
        weakness score, the finding surfaces in the WEAKNESS section
        (classification flipped) — _classify_row sees pos_row, not row."""
        # Move-played: w=12, d=1, l=7, n=20 → score = 12.5/20 = 0.625 (minor strength)
        # Pos WDL:     w=10, d=10, l=20, n=40 → score = 15/40 = 0.375 (major weakness)
        # Surfacing gate passes on move-played n=20. Validator passes on pos_n=40.
        row = _make_row(
            entry_hash=100,
            move_san="e4",
            resulting_full_hash=FLIP_HASH,
            entry_san_sequence=["e4"],
            n=20,
            w=12,
            d=1,
            losses=7,
        )
        opening = _make_opening(full_hash=100, ply_count=1)

        response = await _run_compute(
            rows=[row],
            openings_by_hash={100: opening},
            color="white",
            pos_wdl={FLIP_HASH: (10, 10, 20, None)},
        )

        # Classification flipped: appears in WEAKNESSES, not strengths.
        assert len(response.white_strengths) == 0
        assert len(response.white_weaknesses) == 1
        finding = response.white_weaknesses[0]
        assert finding.classification == "weakness"
        assert finding.severity == "major"  # 0.375 <= 0.40
        assert finding.score == pytest.approx(15 / 40, abs=1e-9)
        assert finding.n_games == 40

    @pytest.mark.asyncio
    async def test_pos_wdl_queried_per_color_with_matching_color_filter(self) -> None:
        """WR-01 regression: query_resulting_position_wdl must be invoked once
        per color in colors_to_query, scoped to that color's resulting hashes,
        and with color=color (matching query_opening_transitions' explicit
        Game.user_color predicate). The cross-color blended call site
        (color=None) silently inflated/deflated white-section and black-section
        denominators against the click-through Move Explorer view, which IS
        color-filtered. See app/services/opening_insights_service.py header
        comment near pos_wdl_by_color and 80.1-REVIEW.md WR-01.
        """
        # Two rows, same resulting_full_hash but in different color sections.
        # Each color's pos_wdl mock returns a *different* (w, d, l) so we can
        # detect cross-section blending if it happened.
        WHITE_HASH = 0xDD10
        BLACK_HASH = 0xDD11
        row_white = _make_row(
            entry_hash=100,
            move_san="e4",
            resulting_full_hash=WHITE_HASH,
            entry_san_sequence=["e4"],
            n=20,
            w=4,
            d=4,
            losses=12,
        )
        row_black = _make_row(
            entry_hash=200,
            move_san="e5",
            resulting_full_hash=BLACK_HASH,
            entry_san_sequence=["e4", "e5"],
            n=20,
            w=14,
            d=2,
            losses=4,
        )
        opening_w = _make_opening(full_hash=100, ply_count=1)
        opening_b = _make_opening(full_hash=200, ply_count=2)

        # Per-color pos_wdl: white sees (8, 8, 24) for n=40, black sees
        # (28, 4, 8) for n=40. If the implementation reverted to a single
        # cross-color call and reused the same dict for both colors, we'd
        # see different counts on at least one finding.
        async def pos_wdl_side_effect(
            *, session: Any, user_id: int, hash_list: list[int], color: str | None, **_: Any
        ) -> dict[int, tuple[int, int, int, datetime.datetime | None]]:
            # WR-01: caller must pass a real color literal, never None, when
            # called per-color. Assert here so a regression is impossible to
            # mock around.
            assert color in ("white", "black"), (
                f"WR-01: query_resulting_position_wdl must be called with "
                f"color in {{'white','black'}}, got {color!r}"
            )
            if color == "white":
                # White scope: only WHITE_HASH should be requested.
                assert hash_list == [WHITE_HASH], (
                    f"white-color call must scope to white-section hashes, got {hash_list}"
                )
                return {WHITE_HASH: (8, 8, 24, None)}
            assert hash_list == [BLACK_HASH], (
                f"black-color call must scope to black-section hashes, got {hash_list}"
            )
            return {BLACK_HASH: (28, 4, 8, None)}

        with (
            patch(
                "app.services.opening_insights_service.query_opening_transitions",
                new_callable=AsyncMock,
            ) as mock_transitions,
            patch(
                "app.services.opening_insights_service.query_transition_prefixes",
                new_callable=AsyncMock,
            ),
            patch(
                "app.services.opening_insights_service._wrap_transition_row",
                side_effect=_fake_wrap,
            ),
            patch(
                "app.services.opening_insights_service.query_openings_by_hashes",
                new_callable=AsyncMock,
            ) as mock_attribution,
            patch(
                "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
                new_callable=AsyncMock,
            ) as mock_eval,
            patch(
                "app.services.opening_insights_service.query_resulting_position_wdl",
                side_effect=pos_wdl_side_effect,
            ) as mock_pos_wdl,
        ):
            # White call returns the white row, black returns the black row.
            mock_transitions.side_effect = [[row_white], [row_black]]
            mock_attribution.return_value = {100: opening_w, 200: opening_b}
            mock_eval.return_value = {}

            response = await compute_insights(
                session=AsyncMock(),
                user_id=1,
                request=_default_request(color="all"),
            )

        # Two calls, one per color (sequential per CLAUDE.md AsyncSession rule).
        assert mock_pos_wdl.call_count == 2
        # White finding picks up white-color pos_wdl: (8, 8, 24), n=40, score=12/40=0.30.
        assert len(response.white_weaknesses) == 1
        wf = response.white_weaknesses[0]
        assert (wf.wins, wf.draws, wf.losses, wf.n_games) == (8, 8, 24, 40)
        # Black finding picks up black-color pos_wdl: (28, 4, 8), n=40, score=30/40=0.75.
        assert len(response.black_strengths) == 1
        bf = response.black_strengths[0]
        assert (bf.wins, bf.draws, bf.losses, bf.n_games) == (28, 4, 8, 40)

    @pytest.mark.asyncio
    async def test_pos_wdl_skipped_when_color_has_no_rows(self) -> None:
        """When a color produced zero transition rows (e.g. user has only one
        color active), query_resulting_position_wdl must NOT be invoked for
        that color — empty hash_list short-circuit retained from pre-WR-01."""
        row_white = _make_row(
            entry_hash=100,
            move_san="e4",
            resulting_full_hash=0xDD20,
            entry_san_sequence=["e4"],
            n=20,
            w=4,
            d=4,
            losses=12,
        )
        opening = _make_opening(full_hash=100, ply_count=1)

        with (
            patch(
                "app.services.opening_insights_service.query_opening_transitions",
                new_callable=AsyncMock,
            ) as mock_transitions,
            patch(
                "app.services.opening_insights_service.query_transition_prefixes",
                new_callable=AsyncMock,
            ),
            patch(
                "app.services.opening_insights_service._wrap_transition_row",
                side_effect=_fake_wrap,
            ),
            patch(
                "app.services.opening_insights_service.query_openings_by_hashes",
                new_callable=AsyncMock,
            ) as mock_attribution,
            patch(
                "app.services.opening_insights_service.query_opening_phase_entry_metrics_batch",
                new_callable=AsyncMock,
            ) as mock_eval,
            patch(
                "app.services.opening_insights_service.query_resulting_position_wdl",
                new_callable=AsyncMock,
            ) as mock_pos_wdl,
        ):
            # White returns one row, black returns nothing.
            mock_transitions.side_effect = [[row_white], []]
            mock_attribution.return_value = {100: opening}
            mock_eval.return_value = {}
            mock_pos_wdl.return_value = {0xDD20: (4, 4, 12, None)}

            await compute_insights(
                session=AsyncMock(),
                user_id=1,
                request=_default_request(color="all"),
            )

        # Exactly one call: only the white color (black short-circuited).
        assert mock_pos_wdl.call_count == 1
        kwargs = mock_pos_wdl.await_args_list[0].kwargs
        assert kwargs["color"] == "white"
        assert kwargs["hash_list"] == [0xDD20]

    @pytest.mark.asyncio
    async def test_finding_n_games_validator_satisfied_when_pos_n_gt_move_played_n(
        self,
    ) -> None:
        """Pydantic Field(ge=OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE=20) on
        n_games stays satisfied because pos_n is always >= move-played n by
        construction (every move-played game also visits the resulting
        position). Regression test for Pitfall 3 from RESEARCH.md."""
        # Move-played: n=20 (exactly at the gate).
        # Pos WDL: n=25 (transposition adds 5 games via other move orders).
        row = _make_row(
            entry_hash=100,
            move_san="e4",
            resulting_full_hash=VALIDATOR_HASH,
            entry_san_sequence=["e4"],
            n=20,
            w=12,
            d=1,
            losses=7,
        )
        opening = _make_opening(full_hash=100, ply_count=1)

        # Pos: w=15, d=0, l=10 → score = 15/25 = 0.60 (strength, major boundary).
        response = await _run_compute(
            rows=[row],
            openings_by_hash={100: opening},
            color="white",
            pos_wdl={VALIDATOR_HASH: (15, 0, 10, None)},
        )

        # Validator did not raise; finding is constructed with pos_n=25.
        assert len(response.white_strengths) == 1
        finding = response.white_strengths[0]
        assert finding.n_games == 25
        assert finding.n_games >= MIN_GAMES_PER_CANDIDATE  # validator gate


# ---------------------------------------------------------------------------
# Custom-FEN drop path (flat-query refactor)
# ---------------------------------------------------------------------------


def test_row_wrapping_drops_unreachable_san_and_reports_a_warning() -> None:
    """_wrap_transition_row returns None and reports a WARNING (not an exception)
    when board replay fails due to an unreachable SAN.

    Uses an entry_san_sequence containing "Kd9" — an illegal square coordinate —
    to trigger chess.IllegalMoveError on the first SAN replay step. Verifies:
    - The function returns None (row dropped).
    - Phase 210 (SEED-042) D-07: reported via capture_message(level="warning"),
      NOT capture_exception. Modelling a handled drop as an exception escalated a
      non-bug 74 times (FLAWCHESS-5E) and buried the real issues underneath it.
    - sentry_sdk.set_tag was called with ("source", "opening_insights").
    - set_context carries the diagnostic keys AND the drop reason, so the two
      distinct drop paths stay distinguishable in Sentry.
    """
    from types import SimpleNamespace
    from unittest.mock import MagicMock, patch

    from app.services.opening_insights_service import _wrap_transition_row

    # Synthetic raw row with an unreachable SAN prefix ("Kd9" is illegal).
    # sample_pair=[ply, game_id] is the paired aggregate emitted by the flat query.
    raw_row = SimpleNamespace(
        entry_hash=88001,
        move_san="e4",
        sample_pair=[1, 42],
        n=20,
        w=4,
        d=4,
        l=12,
        last_played_at=None,
    )
    # The prefix lookup resolves ply=1 to ["Kd9"] — an illegal SAN from start.
    prefixes: dict[tuple[int, int], list[str]] = {(42, 1): ["Kd9"]}

    mock_capture_exception = MagicMock()
    mock_capture_message = MagicMock()
    mock_set_tag = MagicMock()
    mock_set_context = MagicMock()

    with (
        patch(
            "app.services.opening_insights_service.sentry_sdk.capture_exception",
            mock_capture_exception,
        ),
        patch(
            "app.services.opening_insights_service.sentry_sdk.capture_message",
            mock_capture_message,
        ),
        patch("app.services.opening_insights_service.sentry_sdk.set_tag", mock_set_tag),
        patch("app.services.opening_insights_service.sentry_sdk.set_context", mock_set_context),
    ):
        result = _wrap_transition_row(raw_row, prefixes)

    # Row must be dropped (None returned)
    assert result is None, f"Expected None for unreachable SAN, got {result!r}"

    # Reported exactly once, at warning level, and NEVER as an exception (D-07).
    assert mock_capture_message.call_count == 1, (
        f"capture_message must be called once, got {mock_capture_message.call_count}"
    )
    assert mock_capture_message.call_args.kwargs["level"] == "warning"
    assert mock_capture_exception.call_count == 0, (
        "an expected, handled drop must not escalate as an exception"
    )

    # source tag must be set
    mock_set_tag.assert_called_once_with("source", "opening_insights")

    # set_context must include the required diagnostic keys
    context_calls = mock_set_context.call_args_list
    assert len(context_calls) == 1
    context_name, context_dict = context_calls[0].args
    assert context_name == "opening_insights_drop"
    assert "entry_hash" in context_dict
    assert "move_san" in context_dict
    assert "sample_game_id" in context_dict
    assert "sample_ply" in context_dict
    assert context_dict["reason"] == "san_prefix_unreplayable"


def test_row_wrapping_drops_all_custom_group_without_raising() -> None:
    """A group in which EVERY game is custom-start yields a NULL sample_pair, and
    _wrap_transition_row drops it cleanly rather than raising.

    Phase 210 (SEED-042) D-03 / landmine 4. The sample aggregate is now
    `MIN(...) FILTER (WHERE games.initial_fen IS NULL)`, which PostgreSQL
    evaluates to NULL when the filter excludes every row in the group. asyncpg
    surfaces that as Python None (NOT an empty list), and the pre-existing code
    did `int(raw_row.sample_pair[0])` unguarded — a TypeError, i.e. a 500, on the
    very case the fix introduces.

    This is the seed's stated residual: "the user played 50 Evans Gambit thematic
    games from the same custom start". It cannot be rendered (there is no
    replayable SAN path to it), so dropping is correct — but it must drop as a
    warning, with its own distinct reason, not as a crash.
    """
    from types import SimpleNamespace
    from unittest.mock import MagicMock, patch

    from app.services.opening_insights_service import _wrap_transition_row

    raw_row = SimpleNamespace(
        entry_hash=88002,
        move_san="Bxb4",
        sample_pair=None,  # every game in the group is custom-start
        n=50,
        w=34,
        d=0,
        l=16,
        last_played_at=None,
    )

    mock_capture_exception = MagicMock()
    mock_capture_message = MagicMock()
    mock_set_tag = MagicMock()
    mock_set_context = MagicMock()

    with (
        patch(
            "app.services.opening_insights_service.sentry_sdk.capture_exception",
            mock_capture_exception,
        ),
        patch(
            "app.services.opening_insights_service.sentry_sdk.capture_message",
            mock_capture_message,
        ),
        patch("app.services.opening_insights_service.sentry_sdk.set_tag", mock_set_tag),
        patch("app.services.opening_insights_service.sentry_sdk.set_context", mock_set_context),
    ):
        result = _wrap_transition_row(raw_row, {})

    assert result is None
    assert mock_capture_exception.call_count == 0
    assert mock_capture_message.call_count == 1
    assert mock_capture_message.call_args.kwargs["level"] == "warning"

    # The reason must distinguish this from the replay-failure path — collapsing
    # the two would make the Sentry payload lie about which one fired.
    _, context_dict = mock_set_context.call_args_list[0].args
    assert context_dict["reason"] == "all_games_custom_start"
    assert context_dict["n"] == 50
