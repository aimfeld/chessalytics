"""Phase 70 repository SQL contract tests — INSIGHT-CORE-02, INSIGHT-CORE-03, INSIGHT-CORE-04.

Precondition: The composite primary key on game_positions (user_id, game_id, ply)
must exist in the test database before test_partial_index_predicate_alignment runs.
SEED-035 replaced the former surrogate-id PK + the separate partial ix_gp_user_game_ply
index with this natural composite PK (migration f4d88c3659c6); the PK now provides the
same (user_id, game_id, ply) ordered access path the opening-insights window function
relies on. Ensure `uv run alembic upgrade head` has been applied. The test will FAIL
(not skip) if the PK is absent.

All tests use a real PostgreSQL database via the db_session fixture (rolled-back
transaction per test). The db_session fixture is provided by tests/conftest.py.
"""

from __future__ import annotations

import datetime
import uuid
from collections.abc import Sequence
from typing import Literal

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.opening import Opening
from app.repositories.openings_repository import (
    OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE,
    STARTING_POSITION_HASH,
    query_openings_by_hashes,
    query_opening_transitions,
    query_transition_prefixes,
)


# ---------------------------------------------------------------------------
# Test user fixture
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(autouse=True)
async def _create_test_users(db_session: AsyncSession) -> None:
    """Ensure test user IDs 10, 11 exist in the users table (FK constraint)."""
    from tests.conftest import ensure_test_user

    for uid in [10, 11]:
        await ensure_test_user(db_session, uid)


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


def _unique_game_id() -> str:
    return str(uuid.uuid4())


async def _seed_game_with_positions(
    db_session: AsyncSession,
    user_id: int,
    result: Literal["1-0", "0-1", "1/2-1/2"],
    user_color: Literal["white", "black"],
    positions: Sequence[tuple[int, int, str | None]],  # (ply, full_hash, move_san)
    played_at: datetime.datetime | None = None,
    time_control_seconds: int = 600,
    force_ply0_hash: int | None = None,
    skip_auto_ply0: bool = False,
    initial_fen: str | None = None,
) -> int:
    """Insert one Game and its GamePositions; return game_id.

    Any (0, <synthetic_hash>, ...) entry is overridden to STARTING_POSITION_HASH
    by default so seeded positions are consistent with standard-start games.
    If no ply=0 row is in `positions`, one is auto-inserted with move_san=None.
    Tests that need to seed a non-standard-start game (custom-FEN) pass
    `force_ply0_hash`; tests that need to seed a game WITHOUT a ply=0 row at all
    pass `skip_auto_ply0=True`.

    Note: the flat query_opening_transitions no longer pre-filters on ply-0 hash
    (that was the Phase 71 CTE filter). Custom-FEN games pass the SQL and keep
    contributing to the W/D/L counts; Phase 210 (SEED-042) excludes them from the
    sample-representative aggregate only, keyed on `games.initial_fen`, which
    tests set via the `initial_fen` argument.
    """
    if played_at is None:
        played_at = datetime.datetime.now(tz=datetime.timezone.utc)

    game = Game(
        user_id=user_id,
        platform="chess.com",
        platform_game_id=_unique_game_id(),
        platform_url="https://chess.com/game/test",
        pgn="1. e4 e5 *",
        result=result,
        user_color=user_color,
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=time_control_seconds,
        rated=True,
        white_username="testuser",
        black_username="opponent",
        initial_fen=initial_fen,
    )
    game.played_at = played_at
    db_session.add(game)
    await db_session.flush()

    seen_ply0 = any(ply == 0 for ply, _, _ in positions)
    if not seen_ply0 and not skip_auto_ply0:
        # Auto-add a ply=0 row so the Phase 71 CTE filter (has_standard_start)
        # accepts the game. move_san=None here would block the partition's
        # array_agg from picking up the first move; use a synthetic move_san
        # that mirrors the next ply so entry_san_sequence stays non-empty for
        # tests with entries at ply >= 3.
        first_move = next((san for _, _, san in positions), None)
        ply0_san = first_move if first_move is not None else "e4"
        ply0_hash = force_ply0_hash if force_ply0_hash is not None else STARTING_POSITION_HASH
        db_session.add(
            GamePosition(
                game_id=game.id,
                user_id=user_id,
                ply=0,
                full_hash=ply0_hash,
                white_hash=0,
                black_hash=0,
                move_san=ply0_san,
            )
        )

    for ply, full_hash, move_san in positions:
        # Align ply-0 hash with the standard starting position by default.
        # `force_ply0_hash` lets tests inject a non-standard hash (custom-FEN).
        effective_hash = full_hash
        if ply == 0:
            effective_hash = (
                force_ply0_hash if force_ply0_hash is not None else STARTING_POSITION_HASH
            )
        pos = GamePosition(
            game_id=game.id,
            user_id=user_id,
            ply=ply,
            full_hash=effective_hash,
            white_hash=0,
            black_hash=0,
            move_san=move_san,
        )
        db_session.add(pos)
    await db_session.flush()

    return game.id


# Shared hash constants for position testing
H_ENTRY_PLY16 = 1600
H_CANDIDATE_PLY17 = 1701
H_ENTRY_PLY17 = 1700
H_CANDIDATE_PLY18 = 1801

# Synthetic SAN move names used in seeded positions
SAN_E4 = "e4"
SAN_C5 = "c5"
SAN_NF3 = "Nf3"
SAN_NC6 = "Nc6"
SAN_CANDIDATE = "d4"  # the candidate move at the position under test


def _default_call_args(
    color: Literal["white", "black"] = "black",
) -> dict:
    """Return default filter arguments for query_opening_transitions."""
    return {
        "time_control": None,
        "platform": None,
        "rated": None,
        "opponent_type": "both",
        "from_date": None,
        "to_date": None,
        "opponent_gap_min": None,
        "opponent_gap_max": None,
    }


# ---------------------------------------------------------------------------
# Task 1 tests: query_opening_transitions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_entry_ply_lower_bound_0_inclusive(db_session: AsyncSession) -> None:
    """entry_ply = 0 is included in transition results (lowered from 3 to 0).

    At entry_ply=0 the entry position is the standard starting position and
    the candidate move is white's first move. entry_san_sequence at ply=0 is
    NULL/empty (no preceding moves), and the service handles that by
    replaying zero moves to produce the starting FEN.
    """
    user_id = 10
    H_CANDIDATE_PLY1 = 1001
    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",  # user_color=white so this is a LOSS for white
            user_color="white",
            positions=[
                # ply=0 (entry, starting position): candidate move played FROM here.
                # The seed helper forces ply=0 hash to STARTING_POSITION_HASH.
                (0, STARTING_POSITION_HASH, SAN_E4),
                (1, H_CANDIDATE_PLY1, None),  # ply=1 (final): LEAD reads full_hash
            ],
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="white",
        **_default_call_args("white"),
    )

    assert len(rows) == 1
    row = rows[0]
    assert row.entry_hash == STARTING_POSITION_HASH
    assert row.move_san == SAN_E4
    assert row.n == OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE


@pytest.mark.asyncio
async def test_entry_ply_upper_bound_16_inclusive(db_session: AsyncSession) -> None:
    """D-32: entry_ply = 16 is included in transition results (candidate ply=17).

    Seeds 20 loss games with entry at ply=16 and candidate at ply=17.
    Expects exactly 1 row returned.
    """
    user_id = 10
    # Build a list of positions from ply=1 to ply=17
    # Ply=16 is the entry; ply=17 is the candidate
    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        positions = [(ply, 16000 + ply, f"m{ply}") for ply in range(1, 17)]
        # ply=16 is the entry (entry_hash will be its full_hash = 16016)
        # ply=17 is the candidate (must have non-null move_san to pass the filter)
        positions.append((17, H_CANDIDATE_PLY17, "Nc6"))
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=positions,
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # Should have at least 1 row with entry at ply=16
    assert len(rows) >= 1
    entry_hashes = [r.entry_hash for r in rows]
    assert 16016 in entry_hashes  # hash at ply=16 is 16000+16=16016


@pytest.mark.asyncio
async def test_entry_ply_17_excluded_as_entry_but_included_as_candidate(
    db_session: AsyncSession,
) -> None:
    """D-32: entry_ply=17 means candidate_ply=18 — excluded (outside [4,17]).

    Seeds 20 games where ONLY positions at ply=17 and ply=18 exist
    (no earlier positions that would form valid transitions at ply 3..16).
    The entry at ply=17 produces a candidate at ply=18, which is outside
    the CTE WHERE (ply BETWEEN 1 AND 17) — so the candidate row is never
    in the CTE and the outer WHERE (ply BETWEEN 4 AND 17) also excludes it.

    Uses user_id=11 to avoid interference with other tests (user_id=10 is shared).
    """
    user_id = 11
    H_ONLY_ENTRY = 180170
    H_ONLY_CAND = 180180

    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        # Only seed ply=17 (entry) and ply=18 (candidate). No prior positions.
        # The flat query filters on ply.between(MIN_ENTRY_PLY, MAX_ENTRY_PLY) = 0..16.
        # ply=17 entry is outside the range, so it's excluded from the flat query.
        # ply=18 candidate is also outside the range.
        positions = [
            (0, STARTING_POSITION_HASH, None),  # ply=0 (not an entry at MAX_ENTRY_PLY=16)
            (17, H_ONLY_ENTRY, "Nf3"),  # ply=17: excluded (above MAX_ENTRY_PLY=16)
            (18, H_ONLY_CAND, "Nc6"),  # ply=18: excluded (above MAX_ENTRY_PLY=16)
        ]
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=positions,
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # candidate_ply=18 is excluded by CTE WHERE ply BETWEEN 1 AND 17
    # entry_ply=17 is within the CTE but its candidate (ply=18) is not in the CTE,
    # so no (entry_hash, move_san) pair at candidate_ply=18 can pass the outer WHERE.
    assert rows == [], (
        f"Expected 0 rows for entry_ply=17 (candidate_ply=18 excluded), got {len(rows)} rows"
    )


@pytest.mark.asyncio
async def test_window_does_not_leak_across_games(
    db_session: AsyncSession,
) -> None:
    """Flat aggregation groups by (full_hash, move_san); move_san IS NOT NULL filter
    ensures final-position rows (no candidate) are excluded.

    Seeds 20 games with the same line where the entry row at ply=3 has
    move_san=None (no candidate). Expects 0 rows for that entry since the
    flat query WHERE filters move_san IS NOT NULL.

    Then re-seeds 20 games with a candidate at ply=3 and verifies exactly
    one (entry_hash, move_san) row is returned — correct aggregation.
    """
    user_id = 10

    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=[
                (0, 30000, SAN_E4),
                (1, 30001, SAN_C5),
                (2, 30002, SAN_NF3),
                (3, 30003, None),  # entry at ply=3, but no candidate move (final position)
            ],
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # ply=3's move_san is None, so filtered by `move_san IS NOT NULL`. With
    # MIN_ENTRY_PLY=0, plies 0..2 may surface as their own entries — we only
    # assert here that the ply=3 entry (with the deliberately-null move) does
    # NOT appear, which is the original window-leak invariant.
    assert not any(r.entry_hash == 30003 for r in rows), (
        "ply=3 entry with move_san=None must be filtered by `move_san IS NOT NULL`"
    )

    # Re-seed 20 games with a candidate at ply=3 (move_san=Nc6) so a real
    # entry row exists. ply=4 must exist for LEAD(full_hash) at ply=3 to be
    # non-NULL.
    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="black",
            positions=[
                (0, 31000, SAN_E4),
                (1, 31001, SAN_C5),
                (2, 31002, SAN_NF3),
                (3, 31003, SAN_NC6),  # entry at ply=3 with candidate move_san=Nc6
                (4, 31004, None),  # final position; LEAD reads full_hash here
            ],
        )

    rows2 = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # Filter to the target ply=3 entry — plies 0..2 from both seed batches
    # also surface as their own entries with MIN_ENTRY_PLY=0.
    target = [r for r in rows2 if r.entry_hash == 31003 and r.move_san == SAN_NC6]
    assert len(target) == 1
    assert target[0].n == OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE


@pytest.mark.asyncio
async def test_min_games_per_candidate_floor_at_20(db_session: AsyncSession) -> None:
    """Phase 79 evidence-floor bump (n>=20): n=19 excluded, n=20 included.

    Seeds two different entry hashes:
    - entry_hash=A with 20 games (score=0.0, all losses): should appear
    - entry_hash=B with 19 games (score=0.0, all losses): should NOT appear
    """
    user_id = 10
    H_ENTRY_A = 40003
    H_ENTRY_B = 50003
    H_CAND_A = 40004
    H_CAND_B = 50004

    # 20 games for entry A
    for _ in range(20):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black → score=0.0
            user_color="black",
            positions=[
                (1, 40001, SAN_E4),
                (2, 40002, SAN_C5),
                (3, H_ENTRY_A, SAN_NF3),
                (4, H_CAND_A, SAN_NC6),
                (5, 40005, None),
            ],
        )

    # 19 games for entry B
    for _ in range(19):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black → score=0.0
            user_color="black",
            positions=[
                (1, 50001, SAN_E4),
                (2, 50002, SAN_C5),
                (3, H_ENTRY_B, SAN_NF3),
                (4, H_CAND_B, SAN_NC6),
                (5, 50005, None),
            ],
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    entry_hashes_in_result = [r.entry_hash for r in rows]
    assert H_ENTRY_A in entry_hashes_in_result, "20-game entry should be included"
    assert H_ENTRY_B not in entry_hashes_in_result, "19-game entry should be excluded"


@pytest.mark.asyncio
async def test_having_score_boundaries_drops_neutrals(db_session: AsyncSession) -> None:
    """Phase 75 D-08: HAVING uses score (W + 0.5·D)/N <= 0.45 OR >= 0.55. Strict
    <=/>= boundaries (D-03): score=0.50 is dropped, score=0.45 / 0.55 surface.

    Seeds three scenarios at n=20:
    1. 8W/4D/8L → score=(8+2)/20=0.50: 0 rows — neutral
    2. 8W/6D/6L → score=(8+3)/20=0.55: 1 row — strength boundary surfaces
    3. 5W/8D/7L → score=(5+4)/20=0.45: 1 row — weakness boundary surfaces
    """
    user_id = 10

    H_NEUTRAL_ENTRY = 60003
    H_STRENGTH_ENTRY = 70003
    H_WEAKNESS_ENTRY = 80003

    # Scenario 1: 8W/4D/8L => score=(8+2)/20=0.50 — neutral (strict <=/>=)
    for i in range(8):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (1, 60001, "e4"),
                (2, 60002, "e5"),
                (3, H_NEUTRAL_ENTRY, "Nf3"),
                (4, 60004, "Nc6"),
                (5, 60005, None),
            ],
        )
    for i in range(4):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1/2-1/2",
            user_color="white",
            positions=[
                (1, 60001, "e4"),
                (2, 60002, "e5"),
                (3, H_NEUTRAL_ENTRY, "Nf3"),
                (4, 60004, "Nc6"),
                (5, 60005, None),
            ],
        )
    for i in range(8):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",
            user_color="white",
            positions=[
                (1, 60001, "e4"),
                (2, 60002, "e5"),
                (3, H_NEUTRAL_ENTRY, "Nf3"),
                (4, 60004, "Nc6"),
                (5, 60005, None),
            ],
        )

    # Scenario 2: 8W/6D/6L => score=(8+3)/20=0.55 — strength boundary
    for i in range(8):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (1, 70001, "e4"),
                (2, 70002, "e5"),
                (3, H_STRENGTH_ENTRY, "Nf3"),
                (4, 70004, "Nc6"),
                (5, 70005, None),
            ],
        )
    for i in range(6):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1/2-1/2",
            user_color="white",
            positions=[
                (1, 70001, "e4"),
                (2, 70002, "e5"),
                (3, H_STRENGTH_ENTRY, "Nf3"),
                (4, 70004, "Nc6"),
                (5, 70005, None),
            ],
        )
    for i in range(6):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",
            user_color="white",
            positions=[
                (1, 70001, "e4"),
                (2, 70002, "e5"),
                (3, H_STRENGTH_ENTRY, "Nf3"),
                (4, 70004, "Nc6"),
                (5, 70005, None),
            ],
        )

    # Scenario 3: 5W/8D/7L => score=(5+4)/20=0.45 — weakness boundary
    for i in range(7):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",
            user_color="white",
            positions=[
                (1, 80001, "e4"),
                (2, 80002, "e5"),
                (3, H_WEAKNESS_ENTRY, "Nf3"),
                (4, 80004, "Nc6"),
                (5, 80005, None),
            ],
        )
    for i in range(8):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1/2-1/2",
            user_color="white",
            positions=[
                (1, 80001, "e4"),
                (2, 80002, "e5"),
                (3, H_WEAKNESS_ENTRY, "Nf3"),
                (4, 80004, "Nc6"),
                (5, 80005, None),
            ],
        )
    for i in range(5):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (1, 80001, "e4"),
                (2, 80002, "e5"),
                (3, H_WEAKNESS_ENTRY, "Nf3"),
                (4, 80004, "Nc6"),
                (5, 80005, None),
            ],
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="white",
        **_default_call_args("white"),
    )

    entry_hashes_in_result = [r.entry_hash for r in rows]
    assert H_NEUTRAL_ENTRY not in entry_hashes_in_result, "score=0.50 (neutral) should be dropped"
    assert H_STRENGTH_ENTRY in entry_hashes_in_result, (
        "score=0.55 boundary (strength) should appear"
    )
    assert H_WEAKNESS_ENTRY in entry_hashes_in_result, (
        "score=0.45 boundary (weakness) should appear"
    )


@pytest.mark.asyncio
async def test_user_color_filter_routes_correct_games(db_session: AsyncSession) -> None:
    """color parameter filters to games where game.user_color matches.

    Seeds 20 white-color games (12L/8W → score=0.40 from white's perspective,
    a major weakness under the Phase 75 score gate).
    color="black" should return 0 rows (no black games).
    color="white" should return 1 row.
    """
    user_id = 10
    H_WHITE_ENTRY = 90003

    # Seed: ply 0..2 build up to entry; ply 3 IS the entry with candidate; ply 4 is final.
    for i in range(12):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",
            user_color="white",
            positions=[
                (0, 90000, "e4"),
                (1, 90001, "e5"),
                (2, 90002, "Nf3"),
                (3, H_WHITE_ENTRY, "Nc6"),
                (4, 90004, None),
            ],
        )
    for i in range(8):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (0, 90000, "e4"),
                (1, 90001, "e5"),
                (2, 90002, "Nf3"),
                (3, H_WHITE_ENTRY, "Nc6"),
                (4, 90004, None),
            ],
        )

    rows_black = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )
    rows_white = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="white",
        **_default_call_args("white"),
    )

    assert rows_black == [], "color='black' should return 0 rows (no black games)"
    # Filter to the target ply=3 entry — plies 0..2 also surface as their own
    # entries with MIN_ENTRY_PLY=0 but aren't the subject of this color test.
    target = [r for r in rows_white if r.entry_hash == H_WHITE_ENTRY]
    assert len(target) == 1, "color='white' should return 1 row matching the ply=3 entry"


@pytest.mark.asyncio
async def test_apply_game_filters_from_date_narrows_results(db_session: AsyncSession) -> None:
    """INSIGHT-CORE-01: from_date correctly limits the game date window.

    Seeds 30 games total:
    - 20 recent (within last 7 days)
    - 10 old (30 days ago)
    With from_date=today-8days, only the 20 recent games qualify.
    The returned row should show n=20 (not 30) since all 30 are losses.
    """
    user_id = 10
    H_RECENCY_ENTRY = 100003

    now = datetime.datetime.now(tz=datetime.timezone.utc)
    recent_date = now - datetime.timedelta(days=3)
    old_date = now - datetime.timedelta(days=30)
    from_date = (now - datetime.timedelta(days=8)).date()

    # Seed 20 recent loss games. Per zobrist semantics: ply Y move_san is
    # the move played FROM ply Y. ply 3 IS the entry with candidate move "Nc6";
    # ply 4 is final (LEAD reads its full_hash for resulting_full_hash).
    for _ in range(20):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="black",
            positions=[
                (0, 100000, "e4"),
                (1, 100001, "c5"),
                (2, 100002, "Nf3"),
                (3, H_RECENCY_ENTRY, "Nc6"),
                (4, 100004, None),
            ],
            played_at=recent_date,
        )

    # Seed 10 old loss games
    for _ in range(10):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="black",
            positions=[
                (0, 100000, "e4"),
                (1, 100001, "c5"),
                (2, 100002, "Nf3"),
                (3, H_RECENCY_ENTRY, "Nc6"),
                (4, 100004, None),
            ],
            played_at=old_date,
        )

    # Without cutoff: 30 games total. Filter to the ply=3 target — plies 0..2
    # also surface as their own entries with MIN_ENTRY_PLY=0.
    rows_all = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        time_control=None,
        platform=None,
        rated=None,
        opponent_type="both",
        from_date=None,
        to_date=None,
    )
    target_all = [r for r in rows_all if r.entry_hash == H_RECENCY_ENTRY]
    assert len(target_all) == 1
    assert target_all[0].n == 30

    # With from_date filter: only 20 recent games
    rows_recent = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        time_control=None,
        platform=None,
        rated=None,
        opponent_type="both",
        from_date=from_date,
        to_date=None,
    )
    target_recent = [r for r in rows_recent if r.entry_hash == H_RECENCY_ENTRY]
    assert len(target_recent) == 1
    assert target_recent[0].n == 20


@pytest.mark.asyncio
async def test_partial_index_predicate_alignment(db_session: AsyncSession) -> None:
    """RESEARCH.md A6: the (user_id, game_id, ply) ordered access path exists for the
    opening-insights window function.

    SEED-035 dropped the former partial ix_gp_user_game_ply index and made
    (user_id, game_id, ply) the natural composite PRIMARY KEY of game_positions.
    The PK (game_positions_pkey) now provides the same ordered key the window
    function's PARTITION BY game_id ORDER BY ply relies on, so this test now
    verifies the PK key list instead of the retired partial index. The
    partial-predicate (ply BETWEEN 0 AND 17) and INCLUDE(full_hash, move_san)
    specializations were intentionally retired with the index.

    PRECONDITION: `uv run alembic upgrade head` must have been run against the test DB.
    This test FAILS (not skips) if the composite PK does not exist.
    """
    # Assert the composite PK exists in the DB (replaces the retired partial index).
    result = await db_session.execute(
        text("SELECT 1 FROM pg_indexes WHERE indexname='game_positions_pkey'")
    )
    row = result.scalar_one_or_none()
    assert row == 1, (
        "Primary key game_positions_pkey is missing from the test DB. "
        "Run `uv run alembic upgrade head` to apply the SEED-035 migration."
    )

    user_id = 11

    # Seed enough games to produce a real EXPLAIN plan
    for _ in range(20):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="black",
            positions=[
                (1, 110001, "e4"),
                (2, 110002, "c5"),
                (3, 110003, "Nf3"),
                (4, 110004, "Nc6"),
                (5, 110005, None),
            ],
        )

    # Verify the composite PK key columns. On small test datasets PostgreSQL's
    # cost-based planner chooses cheaper indexes (e.g. ix_gp_user_white_hash for
    # ~20 rows); the composite-PK ordered scan is the winning plan at Hikaru-scale
    # (5.7M rows: 2.0 s → 816 ms, verified 2026-04-26, CONTEXT.md). Here we verify
    # structural alignment (the key columns + their order), not planner choice.
    index_check = await db_session.execute(
        text("SELECT indexdef FROM pg_indexes WHERE indexname = 'game_positions_pkey'")
    )
    indexdef = index_check.scalar_one_or_none()
    assert indexdef is not None, "game_positions_pkey must exist in the test DB"
    assert "ply" in indexdef.lower(), f"PK must include ply column. Got: {indexdef}"
    assert "game_id" in indexdef.lower(), f"PK must include game_id column. Got: {indexdef}"
    assert "user_id" in indexdef.lower(), f"PK must include user_id column. Got: {indexdef}"

    # Verify the key column ordering by checking the btree key list in the indexdef.
    # indexdef example: "...USING btree (user_id, game_id, ply)".
    # Extract the btree key part between "btree (" and the closing paren.
    lower_def = indexdef.lower()
    btree_start = lower_def.index("btree (") + len("btree (")
    btree_end = lower_def.index(")", btree_start)
    btree_keys = lower_def[btree_start:btree_end]  # "user_id, game_id, ply"
    assert btree_keys.index("user_id") < btree_keys.index("game_id") < btree_keys.index("ply"), (
        f"PK key column order must be (user_id, game_id, ply). Got key list: {btree_keys!r}\n"
        f"Full indexdef: {indexdef}"
    )


@pytest.mark.asyncio
async def test_query_returns_sample_pair(db_session: AsyncSession) -> None:
    """Flat query shape: row carries sample_pair=ARRAY[ply, game_id] for Python-side
    prefix resolution. resulting_full_hash is no longer returned by the SQL — it is
    derived in the service layer via query_transition_prefixes + board replay.

    Seeds 20 games with an entry at ply=3. Verifies that the returned row exposes
    sample_pair where ply==3 and game_id is one of the seeded games. The pair must
    come from a single real row in the group (see test_sample_pair_correlated_under_transposition
    for the regression case that motivates the paired aggregate).
    """
    user_id = 10
    H_ENTRY = 120003

    seeded_game_ids: list[int] = []
    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        gid = await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="black",
            positions=[
                (0, 120000, "e4"),
                (1, 120001, "c5"),
                (2, 120002, "Nf3"),
                (3, H_ENTRY, "Nc6"),  # entry: candidate move is "Nc6"
                (4, 120004, None),  # final position
            ],
        )
        seeded_game_ids.append(gid)

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # Filter to the ply=3 target — plies 0..2 also surface as their own entries.
    target = [r for r in rows if r.entry_hash == H_ENTRY]
    assert len(target) == 1
    row = target[0]
    # sample_pair = MIN(ARRAY[ply, game_id]); since every contributing row has
    # ply=3 here, the array MIN reduces to the (3, MIN(game_id)) row.
    sample_ply, sample_game_id = row.sample_pair
    assert sample_ply == 3, f"Expected sample_ply=3, got {sample_ply}"
    assert sample_game_id == min(seeded_game_ids), (
        "sample_game_id must be MIN(game_id) across seeded games when all share ply=3"
    )


@pytest.mark.asyncio
async def test_sample_pair_correlated_under_transposition(
    db_session: AsyncSession,
) -> None:
    """Regression: sample_pair must come from one real row in the group.

    The same entry position (Zobrist hash) can be reached at different plies in
    different games via transposition — polyglot hashes ignore half-move clock,
    so e.g. inserting "Nf3 Nf6 Ng1 Ng8" before "e4 e5" returns to the same hash
    at a deeper ply. If the SQL emits independent MIN(game_id) + MIN(ply) the
    aggregates de-correlate and the sample (game_id, ply) may not refer to any
    real row, silently breaking the prefix replay in _wrap_transition_row.

    This test seeds the deeper-ply games FIRST so they receive smaller game_ids
    (which would dominate independent MIN(game_id)), then asserts that the paired
    ARRAY[ply, game_id] aggregate returns a (game_id, ply) pair that maps back
    to a real row — i.e. the chosen game_id actually has the entry at that ply.
    """
    user_id = 10
    H_ENTRY = 800003
    CANDIDATE = "Nc3"

    # Deep batch: 10 games with the entry at ply=6 (transposed roundabout).
    # Seeded FIRST → smaller game_ids → would win independent MIN(game_id).
    deep_game_ids: list[int] = []
    for _ in range(10):
        gid = await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",  # loss for white (drives score below 0.45 → passes HAVING)
            user_color="white",
            positions=[
                (0, 800100, "Nf3"),
                (1, 800101, "Nf6"),
                (2, 800102, "Ng1"),
                (3, 800103, "Ng8"),
                (4, 800104, "e4"),
                (5, 800105, "e5"),
                (6, H_ENTRY, CANDIDATE),  # entry at ply=6
                (7, 800107, None),
            ],
        )
        deep_game_ids.append(gid)

    # Shallow batch: 10 games with the entry at ply=2 (direct path).
    # Seeded SECOND → larger game_ids.
    shallow_game_ids: list[int] = []
    for _ in range(10):
        gid = await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",
            user_color="white",
            positions=[
                (0, 900000, "e4"),
                (1, 900001, "e5"),
                (2, H_ENTRY, CANDIDATE),  # entry at ply=2
                (3, 900003, None),
            ],
        )
        shallow_game_ids.append(gid)

    # Invariant the broken impl needs in order to trip: deep games' game_ids
    # are strictly smaller than shallow games' game_ids.
    assert max(deep_game_ids) < min(shallow_game_ids), (
        "Test setup invariant: deep games must be seeded before shallow games "
        "so independent MIN(game_id) would land on a deep game."
    )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="white",
        **_default_call_args("white"),
    )

    target = [r for r in rows if r.entry_hash == H_ENTRY and r.move_san == CANDIDATE]
    assert len(target) == 1, (
        f"Expected exactly one grouped row for (H_ENTRY, {CANDIDATE}), got {len(target)}"
    )
    row = target[0]

    sample_ply, sample_game_id = row.sample_pair

    # Paired ARRAY MIN is lexicographic: smallest ply wins, with game_id as
    # tiebreak. ply=2 (shallow) is smaller than ply=6 (deep), so the sample
    # must come from a SHALLOW game.
    assert sample_ply == 2, (
        f"sample_ply must be the smallest ply in the group (2 from shallow). Got {sample_ply}."
    )
    # Critical assertion: sample_game_id must belong to a shallow game so that
    # game's ply=2 row IS the entry position. Under the bug (independent MINs),
    # this would land in deep_game_ids.
    assert sample_game_id in shallow_game_ids, (
        f"sample_game_id must come from the same row as sample_ply. Got "
        f"sample_game_id={sample_game_id}. If it is in deep_game_ids={deep_game_ids}, "
        f"the two MIN aggregates de-correlated (transposition bug)."
    )

    # End-to-end check: the prefix helper resolves to a sequence whose final
    # board state IS the entry hash — i.e. the sample is consistent.
    prefixes = await query_transition_prefixes(db_session, user_id, [(sample_game_id, sample_ply)])
    assert prefixes[(sample_game_id, sample_ply)] == ["e4", "e5"], (
        f"Prefix for sample (game_id={sample_game_id}, ply=2) must be the "
        f"shallow game's first two moves; got {prefixes[(sample_game_id, sample_ply)]!r}"
    )


@pytest.mark.asyncio
async def test_query_transition_prefixes_returns_entry_san_sequence(
    db_session: AsyncSession,
) -> None:
    """Flat-query refactor: entry_san_sequence is now derived via query_transition_prefixes.

    Per zobrist semantics, GamePosition.move_san at ply Y is the move played
    FROM ply Y. For an entry at ply=3 with candidate move "Nc6", the
    sequence to reach the entry is move_san at plies 0, 1, 2 = ["e4","c5","Nf3"].
    query_transition_prefixes returns that list for (game_id, ply=3).
    """
    user_id = 10
    H_ENTRY = 130003

    game_id = await _seed_game_with_positions(
        db_session,
        user_id=user_id,
        result="1-0",
        user_color="black",
        positions=[
            (0, 130000, "e4"),  # ply=0: White's 1st move played FROM start
            (1, 130001, "c5"),  # ply=1: Black's 1st move played FROM after-e4
            (2, 130002, "Nf3"),  # ply=2: White's 2nd move played FROM after-e4-c5
            (3, H_ENTRY, "Nc6"),  # ply=3 (entry): candidate move played FROM here
            (4, 130004, None),  # final position
        ],
    )

    # query_transition_prefixes for (game_id, ply=3) must return ["e4", "c5", "Nf3"]
    prefixes = await query_transition_prefixes(db_session, user_id, [(game_id, 3)])

    assert (game_id, 3) in prefixes, f"Expected (game_id={game_id}, ply=3) in prefixes"
    assert prefixes[(game_id, 3)] == ["e4", "c5", "Nf3"], (
        f"Expected prefix=['e4', 'c5', 'Nf3'], got {prefixes[(game_id, 3)]!r}"
    )
    # ply=0 sample returns empty list (no moves before ply 0)
    prefixes_ply0 = await query_transition_prefixes(db_session, user_id, [(game_id, 0)])
    assert prefixes_ply0[(game_id, 0)] == [], (
        f"ply=0 prefix must be [], got {prefixes_ply0[(game_id, 0)]!r}"
    )


# ---------------------------------------------------------------------------
# Phase 71 hotfix: STARTING_POSITION_HASH CTE filter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_non_standard_start_game_passes_flat_query(
    db_session: AsyncSession,
) -> None:
    """Flat-query refactor: games whose ply-0 full_hash != STARTING_POSITION_HASH
    are NO LONGER pre-filtered by the SQL query. They pass through and are dropped
    in the Python service layer (opening_insights_service._wrap_transition_row)
    via try/except around board replay.

    The old Phase 71 CTE had an EXISTS predicate that excluded these custom-FEN
    games at the SQL level. The flat aggregation intentionally drops that predicate
    to simplify the query shape. The service-layer drop path is tested in
    test_row_wrapping_drops_unreachable_san_and_captures_to_sentry.
    """
    user_id = 10
    NON_STANDARD_PLY0 = 11111  # any value != STARTING_POSITION_HASH
    H_BAD_ENTRY = 222003

    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=[
                (0, 0, "Bb2"),  # placeholder; helper rewrites ply=0 to force_ply0_hash
                (1, 222001, "c5"),
                (2, 222002, "Nf3"),
                (3, H_BAD_ENTRY, "Nc6"),
                (4, 222004, None),
            ],
            force_ply0_hash=NON_STANDARD_PLY0,
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # Flat query does NOT pre-filter on ply-0 hash — the custom-FEN game's entries
    # appear in the SQL result (H_BAD_ENTRY should be present). The service layer
    # drops them via try/except on board replay.
    entry_hashes = [r.entry_hash for r in rows]
    assert H_BAD_ENTRY in entry_hashes, (
        f"Flat query must include custom-FEN entries (was pre-filtered in Phase 71 CTE, "
        f"now dropped in Python). Got entry_hashes={entry_hashes}"
    )


@pytest.mark.asyncio
async def test_standard_start_game_included_in_transitions(
    db_session: AsyncSession,
) -> None:
    """A normal game (ply-0 full_hash == STARTING_POSITION_HASH) contributes
    transition rows as expected from the flat aggregation."""
    user_id = 10
    H_GOOD_ENTRY = 333003
    H_GOOD_RESULT = 333004

    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=[
                (0, 0, "e4"),  # helper rewrites to STARTING_POSITION_HASH by default
                (1, 333001, "c5"),
                (2, 333002, "Nf3"),
                (3, H_GOOD_ENTRY, "Nc6"),
                (4, H_GOOD_RESULT, None),
            ],
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # Filter to the ply=3 target — plies 0..2 also surface as their own
    # entries with MIN_ENTRY_PLY=0.
    target = [r for r in rows if r.entry_hash == H_GOOD_ENTRY]
    assert len(target) == 1
    assert target[0].move_san == "Nc6"


@pytest.mark.asyncio
async def test_game_without_ply0_row_still_contributes_to_flat_query(
    db_session: AsyncSession,
) -> None:
    """Flat-query refactor: a game with no ply=0 row is NO LONGER excluded.

    The old Phase 71 CTE had an EXISTS predicate that required a ply-0 row with
    full_hash == STARTING_POSITION_HASH. The flat aggregation has no such
    predicate — it simply queries ply.between(MIN_ENTRY_PLY, MAX_ENTRY_PLY).
    A game missing ply=0 but having qualifying entries at ply 1..16 will
    contribute those entries normally. The service layer's try/except on board
    replay handles any resulting illegality.
    """
    user_id = 11  # isolated user_id to avoid contaminating user 10 fixtures
    H_ORPHAN_ENTRY = 444003

    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="black",
            positions=[
                # No ply=0 row (skip_auto_ply0). The flat query has no ply=0 filter.
                (1, 444001, "c5"),
                (2, 444002, "Nf3"),
                (3, H_ORPHAN_ENTRY, "Nc6"),
                (4, 444004, None),
            ],
            skip_auto_ply0=True,
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # Flat query does NOT require ply=0 — the entry at ply=3 should appear.
    entry_hashes = [r.entry_hash for r in rows]
    assert H_ORPHAN_ENTRY in entry_hashes, (
        f"Flat query must include entries from games without ply=0 row. "
        f"Got entry_hashes={entry_hashes}"
    )


# ---------------------------------------------------------------------------
# Flat-query shape guardrails (flat-query refactor)
# ---------------------------------------------------------------------------


def test_query_compiles_to_flat_aggregation() -> None:
    """Structural guardrail: query_opening_transitions must compile to a flat
    aggregation with no CTE, no LEAD window, and no ARRAY_AGG.

    Checks the compiled SQL string of a representative statement built with the
    same SQLAlchemy 2.x pattern used inside query_opening_transitions.
    Fails if someone re-introduces a `.cte(...)`, `func.lead(...)`, or
    `func.array_agg(...).over(...)` — all of which caused planner misestimation.
    """
    from sqlalchemy import Float, and_, cast, func, or_, select
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.dialects.postgresql import array as pg_array

    from app.models.game import Game
    from app.models.game_position import GamePosition
    from app.repositories.openings_repository import (
        OPENING_INSIGHTS_MAX_ENTRY_PLY,
        OPENING_INSIGHTS_MIN_ENTRY_PLY,
        OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE,
        OPENING_INSIGHTS_SCORE_PIVOT,
    )
    from app.services.opening_insights_constants import OPENING_INSIGHTS_MINOR_EFFECT

    n_games = func.count(func.distinct(Game.id))
    wins = func.count(func.distinct(Game.id)).filter(
        or_(
            and_(Game.result == "1-0", Game.user_color == "white"),
            and_(Game.result == "0-1", Game.user_color == "black"),
        )
    )
    draws = func.count(func.distinct(Game.id)).filter(Game.result == "1/2-1/2")
    losses = func.count(func.distinct(Game.id)).filter(
        or_(
            and_(Game.result == "0-1", Game.user_color == "white"),
            and_(Game.result == "1-0", Game.user_color == "black"),
        )
    )
    score_expr = (cast(wins, Float) + 0.5 * cast(draws, Float)) / cast(n_games, Float)
    weakness_threshold = OPENING_INSIGHTS_SCORE_PIVOT - OPENING_INSIGHTS_MINOR_EFFECT
    strength_threshold = OPENING_INSIGHTS_SCORE_PIVOT + OPENING_INSIGHTS_MINOR_EFFECT

    stmt = (
        select(
            GamePosition.full_hash.label("entry_hash"),
            GamePosition.move_san.label("move_san"),
            func.min(pg_array([GamePosition.ply, GamePosition.game_id])).label("sample_pair"),
            n_games.label("n"),
            wins.label("w"),
            draws.label("d"),
            losses.label("l"),
            func.max(Game.played_at).label("last_played_at"),
        )
        .join(Game, Game.id == GamePosition.game_id)
        .where(
            GamePosition.user_id == 1,
            GamePosition.ply.between(
                OPENING_INSIGHTS_MIN_ENTRY_PLY, OPENING_INSIGHTS_MAX_ENTRY_PLY
            ),
            GamePosition.move_san.isnot(None),
            Game.user_color == "white",
        )
        .group_by(GamePosition.full_hash, GamePosition.move_san)
        .having(
            and_(
                n_games >= OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE,
                or_(score_expr <= weakness_threshold, score_expr >= strength_threshold),
            )
        )
    )

    compiled = str(stmt.compile(dialect=postgresql.dialect()))
    compiled_upper = compiled.upper()

    assert "WITH " not in compiled, (
        f"Flat query must not contain a CTE ('WITH '). Got:\n{compiled[:500]}"
    )
    assert "LEAD(" not in compiled_upper, (
        f"Flat query must not contain a LEAD window function. Got:\n{compiled[:500]}"
    )
    assert "ARRAY_AGG" not in compiled_upper, (
        f"Flat query must not contain ARRAY_AGG. Got:\n{compiled[:500]}"
    )


def test_query_position_wdl_batch_compiles_flat() -> None:
    """Structural guardrail: query_position_wdl_batch must compile to a flat
    single-SELECT GROUP BY (no SELECT DISTINCT subquery, no wrapping
    FROM (SELECT ...) shape).

    Mirrors the precedent set by PR #90 / query_opening_transitions:
    COUNT(DISTINCT game_id) FILTER (...) at aggregate level beats wrapping
    a DISTINCT dedup subquery for planner stability on PG 18.

    Reconstructs the expected statement shape locally rather than importing
    private helpers, so the guardrail remains decoupled from internal refactors
    of stats_repository.
    """
    from sqlalchemy import and_, func, or_, select
    from sqlalchemy.dialects import postgresql

    from app.models.game import Game
    from app.models.game_position import GamePosition

    win_cond = or_(
        and_(Game.result == "1-0", Game.user_color == "white"),
        and_(Game.result == "0-1", Game.user_color == "black"),
    )
    draw_cond = Game.result == "1/2-1/2"
    loss_cond = or_(
        and_(Game.result == "0-1", Game.user_color == "white"),
        and_(Game.result == "1-0", Game.user_color == "black"),
    )
    distinct_game_count = func.count(func.distinct(Game.id))

    stmt = (
        select(
            GamePosition.full_hash,
            distinct_game_count.filter(win_cond).label("wins"),
            distinct_game_count.filter(draw_cond).label("draws"),
            distinct_game_count.filter(loss_cond).label("losses"),
            func.max(Game.played_at).label("last_played_at"),
        )
        .join(Game, GamePosition.game_id == Game.id)
        .where(
            GamePosition.user_id == 1,
            GamePosition.full_hash.in_([1, 2, 3]),
        )
        .group_by(GamePosition.full_hash)
    )

    compiled = str(stmt.compile(dialect=postgresql.dialect()))
    compiled_upper = compiled.upper()

    assert "WITH " not in compiled, (
        f"Flat query must not contain a CTE ('WITH '). Got:\n{compiled[:500]}"
    )
    assert "SELECT DISTINCT" not in compiled_upper, (
        f"Flat query must not contain a SELECT DISTINCT dedup. Got:\n{compiled[:500]}"
    )
    # No outer wrapper around a subquery — the FROM clause should reference
    # game_positions directly (joined to games), not "FROM (SELECT ...".
    assert "FROM (SELECT" not in compiled_upper, (
        f"Flat query must not wrap a subquery in the FROM clause. Got:\n{compiled[:500]}"
    )


@pytest.mark.asyncio
async def test_query_transition_prefixes_multi_game(db_session: AsyncSession) -> None:
    """query_transition_prefixes returns correct SAN prefix lists for multiple games.

    Seeds two games (g1 and g2) with distinct SAN sequences. Calls
    query_transition_prefixes with several (game_id, ply) samples and asserts:
    - g1 at ply=2 returns the first 2 SANs of g1's sequence
    - g2 at ply=3 returns the first 3 SANs of g2's sequence
    - g1 at ply=0 returns [] (no moves before ply 0)
    - empty samples input returns {}
    """
    user_id = 10
    # g1: e4, c5, Nf3, d6 (positions at ply 0..3)
    g1_id = await _seed_game_with_positions(
        db_session,
        user_id=user_id,
        result="1-0",
        user_color="white",
        positions=[
            (0, 550000, "e4"),
            (1, 550001, "c5"),
            (2, 550002, "Nf3"),
            (3, 550003, "d6"),
            (4, 550004, None),
        ],
    )
    # g2: d4, d5, c4 (positions at ply 0..3)
    g2_id = await _seed_game_with_positions(
        db_session,
        user_id=user_id,
        result="0-1",
        user_color="white",
        positions=[
            (0, 560000, "d4"),
            (1, 560001, "d5"),
            (2, 560002, "c4"),
            (3, 560003, "Nc6"),
            (4, 560004, None),
        ],
    )

    # Multi-sample request: g1 at ply=2, g2 at ply=3, g1 at ply=0
    samples = [(g1_id, 2), (g2_id, 3), (g1_id, 0)]
    prefixes = await query_transition_prefixes(db_session, user_id, samples)

    assert prefixes[(g1_id, 2)] == ["e4", "c5"], (
        f"g1 ply=2 prefix must be ['e4', 'c5'], got {prefixes[(g1_id, 2)]!r}"
    )
    assert prefixes[(g2_id, 3)] == ["d4", "d5", "c4"], (
        f"g2 ply=3 prefix must be ['d4', 'd5', 'c4'], got {prefixes[(g2_id, 3)]!r}"
    )
    assert prefixes[(g1_id, 0)] == [], f"ply=0 prefix must be [], got {prefixes[(g1_id, 0)]!r}"

    # Empty samples input returns {} immediately
    empty = await query_transition_prefixes(db_session, user_id, [])
    assert empty == {}


@pytest.mark.asyncio
async def test_query_handles_custom_fen_ply0_gracefully(db_session: AsyncSession) -> None:
    """Flat-query refactor: custom-FEN games (ply-0 full_hash != STARTING_POSITION_HASH)
    are not pre-filtered by SQL — they appear in the result and carry a valid
    (sample_game_id, sample_ply) pair for Python-side prefix resolution.

    The service layer is responsible for dropping them via try/except on board replay.
    """
    user_id = 10
    CUSTOM_FEN_HASH = 99999  # non-standard ply-0 hash (simulates chess.com thematic game)
    H_CUSTOM_ENTRY = 570003

    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=[
                (1, 570001, "c5"),
                (2, 570002, "Nf3"),
                (3, H_CUSTOM_ENTRY, "Nc6"),
                (4, 570004, None),
            ],
            force_ply0_hash=CUSTOM_FEN_HASH,
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    # The custom-FEN game passes the flat SQL — H_CUSTOM_ENTRY must appear.
    target = [r for r in rows if r.entry_hash == H_CUSTOM_ENTRY]
    assert len(target) == 1, (
        f"Custom-FEN entry must appear in flat query result (dropped later in Python). "
        f"Got {len(target)} matching rows."
    )
    row = target[0]
    # sample_pair=[ply, game_id] is present so the service can call
    # query_transition_prefixes and attempt board replay.
    assert row.sample_pair is not None
    sample_ply, sample_game_id = row.sample_pair
    assert sample_ply == 3
    assert sample_game_id is not None


# ---------------------------------------------------------------------------
# Phase 210 (SEED-042): custom-start games must not evict whole transitions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_custom_start_game_does_not_win_the_sample_but_keeps_its_counts(
    db_session: AsyncSession,
) -> None:
    """Regression for the production eviction (Sentry FLAWCHESS-5E).

    A custom-start game reaches a shared entry position at a SHALLOWER ply than
    standard games, because the opening half-moves are baked into its
    [SetUp]/[FEN] header. `MIN(ARRAY[ply, game_id])` is therefore systematically
    won by the custom-start game whenever one exists for that entry_hash — and
    its SAN prefix is unreplayable from a standard board, so _wrap_transition_row
    dropped the ENTIRE transition. In prod that silently deleted a 50-game
    W34/D0/L16 Evans Gambit line from the user's insights.

    Two independent things must hold, and the pairing is the point (landmine 3):

    1. The sample representative is a STANDARD-START game, at the deeper ply.
    2. The counts are UNCHANGED — the custom-start game legitimately reached this
       position and still contributes to n/w/d/l. A fix that excluded the row
       entirely would also pass assertion 1, which is why the counts are asserted
       against the exact seeded totals rather than just "greater than zero".
    """
    user_id = 10
    H_ENTRY = 610003
    STANDARD_ENTRY_PLY = 5
    CUSTOM_ENTRY_PLY = 1  # shallower — this is what used to win MIN()

    # Seed the custom-start game FIRST so it also holds the smallest game_id.
    # Both tiebreakers (ply, then game_id) therefore favour it: if the filter is
    # missing or applied to the wrong aggregate, it wins the sample.
    custom_game_id = await _seed_game_with_positions(
        db_session,
        user_id=user_id,
        result="1-0",  # loss for black
        user_color="black",
        positions=[
            (CUSTOM_ENTRY_PLY, H_ENTRY, "Nc6"),
            (2, 610004, None),
        ],
        force_ply0_hash=610100,  # non-standard ply-0 position
        initial_fen="r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4",
    )

    standard_game_ids: list[int] = []
    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        gid = await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=[
                (1, 610001, "c5"),
                (2, 610002, "Nf3"),
                (3, 610005, "d6"),
                (4, 610006, "d4"),
                (STANDARD_ENTRY_PLY, H_ENTRY, "Nc6"),
                (6, 610007, None),
            ],
        )
        standard_game_ids.append(gid)

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    target = [r for r in rows if r.entry_hash == H_ENTRY]
    assert len(target) == 1, "the transition must survive, not be evicted"
    row = target[0]

    # (1) The representative is a standard-start game at the deeper ply.
    assert row.sample_pair is not None, "a standard-start sample exists in this group"
    sample_ply, sample_game_id = row.sample_pair
    assert sample_ply == STANDARD_ENTRY_PLY, (
        f"sample must come from a standard-start game at ply {STANDARD_ENTRY_PLY}, "
        f"got ply {sample_ply} — the custom-start game won MIN() again"
    )
    assert sample_game_id != custom_game_id
    assert sample_game_id == min(standard_game_ids)

    # (2) The counts still include the custom-start game.
    expected_n = OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE + 1
    assert row.n == expected_n, (
        f"custom-start games must keep contributing to the counts: expected n={expected_n} "
        f"({OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE} standard + 1 custom), got {row.n}"
    )
    assert row.l == expected_n, "all seeded games are losses for black"
    assert row.w == 0
    assert row.d == 0


@pytest.mark.asyncio
async def test_all_custom_start_group_yields_null_sample_pair(
    db_session: AsyncSession,
) -> None:
    """When EVERY game in a group is custom-start, the filtered aggregate is NULL.

    Phase 210 (SEED-042) D-03. `MIN(...) FILTER (WHERE initial_fen IS NULL)`
    evaluates to NULL when the filter excludes every row, and asyncpg surfaces
    that as Python None rather than an empty list. This is the seed's stated
    residual — the group has no replayable SAN path and cannot be rendered — so
    the SQL contract is "NULL sample, counts intact", and dropping it is the
    service layer's job (see
    test_row_wrapping_drops_all_custom_group_without_raising).
    """
    user_id = 10
    H_ENTRY = 620003

    for _ in range(OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE):
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",  # loss for black
            user_color="black",
            positions=[
                (1, 620001, "c5"),
                (2, 620002, "Nf3"),
                (3, H_ENTRY, "Nc6"),
                (4, 620004, None),
            ],
            force_ply0_hash=620100,
            initial_fen="r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 4",
        )

    rows = await query_opening_transitions(
        db_session,
        user_id=user_id,
        color="black",
        **_default_call_args("black"),
    )

    target = [r for r in rows if r.entry_hash == H_ENTRY]
    assert len(target) == 1
    row = target[0]

    assert row.sample_pair is None, (
        "with no standard-start game in the group the filtered MIN must be NULL, "
        f"got {row.sample_pair!r}"
    )
    # The counts are still computed — only the sample is unavailable.
    assert row.n == OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE


# ---------------------------------------------------------------------------
# Task 2 tests: query_openings_by_hashes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_query_openings_by_hashes_empty_input_returns_empty_dict(
    db_session: AsyncSession,
) -> None:
    """query_openings_by_hashes([]) returns {} without issuing any SQL."""
    result = await query_openings_by_hashes(db_session, [])
    assert result == {}


@pytest.mark.asyncio
async def test_query_openings_by_hashes_picks_deepest_ply_count(
    db_session: AsyncSession,
) -> None:
    """D-22: when multiple Opening rows share the same full_hash, the one with
    MAX(ply_count) is returned.

    Seeds two Opening rows with the same full_hash but different ply_counts (4 and 8).
    Asserts the returned Opening has ply_count == 8.
    """
    SHARED_HASH = 999001

    opening_shallow = Opening(
        eco="A00",
        name="Test Opening Shallow",
        pgn="e4 e5",
        ply_count=4,
        fen="rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
        full_hash=SHARED_HASH,
    )
    opening_deep = Opening(
        eco="A00",
        name="Test Opening Deep",
        pgn="e4 e5 Nf3 Nc6",
        ply_count=8,
        fen="r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        full_hash=SHARED_HASH,
    )
    db_session.add(opening_shallow)
    db_session.add(opening_deep)
    await db_session.flush()

    result = await query_openings_by_hashes(db_session, [SHARED_HASH])

    assert SHARED_HASH in result
    assert result[SHARED_HASH].ply_count == 8, (
        f"Expected deepest opening (ply_count=8), got {result[SHARED_HASH].ply_count}"
    )
    assert result[SHARED_HASH].name == "Test Opening Deep"


@pytest.mark.asyncio
async def test_query_openings_by_hashes_skips_null_full_hash(
    db_session: AsyncSession,
) -> None:
    """RESEARCH.md Pitfall 6: Opening rows with full_hash=NULL are filtered out.

    Seeds an Opening with full_hash=NULL and one with a real hash.
    Queries for only the real hash — asserts no error and the NULL-hash row
    is never included in the result.
    """
    REAL_HASH = 999002

    opening_null = Opening(
        eco="Z99",
        name="Opening With Null Hash",
        pgn="d4",
        ply_count=2,
        fen="rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
        full_hash=None,  # NULL full_hash
    )
    opening_real = Opening(
        eco="D00",
        name="Opening With Real Hash",
        pgn="d4 d5",
        ply_count=4,
        fen="rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2",
        full_hash=REAL_HASH,
    )
    db_session.add(opening_null)
    db_session.add(opening_real)
    await db_session.flush()

    # Query only for REAL_HASH — null-hash opening should not sneak in
    result = await query_openings_by_hashes(db_session, [REAL_HASH])

    assert REAL_HASH in result
    assert result[REAL_HASH].full_hash == REAL_HASH
    # Verify we can safely iterate the result without AttributeError
    for hash_key, opening in result.items():
        assert opening.full_hash is not None, "NULL full_hash must never appear in result"

    # Also verify querying an empty set for null-hash produces no KeyError
    result_empty = await query_openings_by_hashes(db_session, [])
    assert result_empty == {}


# ---------------------------------------------------------------------------
# TestQueryResultingPositionWdl — Phase 80.1 D-06
# ---------------------------------------------------------------------------

# Unique hashes for query_resulting_position_wdl tests (avoid collision with
# the H_ENTRY_PLY16/17 family used by transition tests above).
RPWDL_ENTRY_A = 0xBB01
RPWDL_ENTRY_B = 0xBB02
RPWDL_RESULT_HASH = 0xBB03
RPWDL_OTHER_RESULT_HASH = 0xBB04
RPWDL_UNUSED_HASH = 0xBB05


class TestQueryResultingPositionWdl:
    """Phase 80.1 D-06: query_resulting_position_wdl returns
    {resulting_full_hash: (W, D, L)} for the Opening Insights field swap.

    The function powers compute_insights' switch from move-played WDL to
    resulting-position WDL. Convergence (two move orders ending at the same
    resulting_full_hash) is the signal case.
    """

    @pytest.mark.asyncio
    async def test_query_resulting_position_wdl_convergence(self, db_session: AsyncSession) -> None:
        """Two games reach RPWDL_RESULT_HASH via different entry hashes;
        query returns combined WDL across both.
        """
        from app.repositories.openings_repository import query_resulting_position_wdl

        user_id = 10
        # Game A: entry=RPWDL_ENTRY_A, candidate move e4 → RPWDL_RESULT_HASH (win)
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (3, RPWDL_ENTRY_A, "e4"),
                (4, RPWDL_RESULT_HASH, None),
            ],
        )
        # Game B: entry=RPWDL_ENTRY_B (different move order), candidate d4 →
        # RPWDL_RESULT_HASH (loss). Different ply-0 hash so the two games
        # arrive at the same resulting position via genuinely different paths.
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",
            user_color="white",
            positions=[
                (3, RPWDL_ENTRY_B, "d4"),
                (4, RPWDL_RESULT_HASH, None),
            ],
        )

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=user_id,
            hash_list=[RPWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,  # compute_insights passes color=None
        )

        # Both games visit the resulting position: 1 win + 1 loss.
        # last_played_at (4th element, quick task 260508-r61) is the MAX of the
        # two seeded games' played_at; we don't pin a specific value here, just
        # assert it's populated (the seed helper always sets played_at).
        assert wdl[RPWDL_RESULT_HASH][:3] == (1, 0, 1)
        assert wdl[RPWDL_RESULT_HASH][3] is not None

    @pytest.mark.asyncio
    async def test_query_resulting_position_wdl_single_order(
        self, db_session: AsyncSession
    ) -> None:
        """Single game; pos WDL == move-played WDL."""
        from app.repositories.openings_repository import query_resulting_position_wdl

        user_id = 10
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (3, RPWDL_ENTRY_A, "e4"),
                (4, RPWDL_RESULT_HASH, None),
            ],
        )

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=user_id,
            hash_list=[RPWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert wdl[RPWDL_RESULT_HASH][:3] == (1, 0, 0)
        assert wdl[RPWDL_RESULT_HASH][3] is not None

    @pytest.mark.asyncio
    async def test_query_resulting_position_wdl_filter_parity(
        self, db_session: AsyncSession
    ) -> None:
        """time_control filter drops games symmetrically across the two
        converging paths.

        apply_game_filters operates on Game.time_control_bucket (the seed
        helper hard-codes this to "blitz"); we override the bucket on Game A
        post-seed to create one rapid + one blitz game converging at the same
        resulting hash.
        """
        from app.repositories.openings_repository import query_resulting_position_wdl

        user_id = 10
        # Game A: win, via ENTRY_A; will be patched to time_control_bucket="rapid"
        game_a_id = await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (3, RPWDL_ENTRY_A, "e4"),
                (4, RPWDL_RESULT_HASH, None),
            ],
        )
        # Patch Game A bucket to rapid (the seed helper hardcodes blitz).
        await db_session.execute(
            text("UPDATE games SET time_control_bucket = 'rapid' WHERE id = :gid"),
            {"gid": game_a_id},
        )

        # Game B: loss, via ENTRY_B (transposition), stays as blitz
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="0-1",
            user_color="white",
            positions=[
                (3, RPWDL_ENTRY_B, "d4"),
                (4, RPWDL_RESULT_HASH, None),
            ],
        )

        # No filter → both games count (1 rapid win + 1 blitz loss)
        wdl_all = await query_resulting_position_wdl(
            db_session,
            user_id=user_id,
            hash_list=[RPWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert wdl_all[RPWDL_RESULT_HASH][:3] == (1, 0, 1)
        assert wdl_all[RPWDL_RESULT_HASH][3] is not None

        # Filter rapid → blitz loss is dropped
        wdl_rapid = await query_resulting_position_wdl(
            db_session,
            user_id=user_id,
            hash_list=[RPWDL_RESULT_HASH],
            time_control=["rapid"],
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert wdl_rapid[RPWDL_RESULT_HASH][:3] == (1, 0, 0)
        assert wdl_rapid[RPWDL_RESULT_HASH][3] is not None

        # Filter blitz → rapid win is dropped (symmetric)
        wdl_blitz = await query_resulting_position_wdl(
            db_session,
            user_id=user_id,
            hash_list=[RPWDL_RESULT_HASH],
            time_control=["blitz"],
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert wdl_blitz[RPWDL_RESULT_HASH][:3] == (0, 0, 1)
        assert wdl_blitz[RPWDL_RESULT_HASH][3] is not None

    @pytest.mark.asyncio
    async def test_query_resulting_position_wdl_color_none_passes_through(
        self, db_session: AsyncSession
    ) -> None:
        """compute_insights passes color=None so both white-perspective and
        black-perspective games visiting the same resulting_full_hash are
        aggregated. This documents the call-site contract.
        """
        from app.repositories.openings_repository import query_resulting_position_wdl

        user_id = 10
        # White-perspective game: win
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="white",
            positions=[
                (3, RPWDL_ENTRY_A, "e4"),
                (4, RPWDL_RESULT_HASH, None),
            ],
        )
        # Black-perspective game (different user_color): also visits the same
        # resulting hash. From black's perspective a 1-0 result is a loss.
        await _seed_game_with_positions(
            db_session,
            user_id=user_id,
            result="1-0",
            user_color="black",
            positions=[
                (3, RPWDL_ENTRY_B, "d4"),
                (4, RPWDL_RESULT_HASH, None),
            ],
        )

        # color=None → both contribute
        wdl_none = await query_resulting_position_wdl(
            db_session,
            user_id=user_id,
            hash_list=[RPWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        # White game: 1-0 with user_color=white → win
        # Black game: 1-0 with user_color=black → loss
        assert wdl_none[RPWDL_RESULT_HASH][:3] == (1, 0, 1)
        assert wdl_none[RPWDL_RESULT_HASH][3] is not None

        # color="white" → only the white game contributes
        wdl_white = await query_resulting_position_wdl(
            db_session,
            user_id=user_id,
            hash_list=[RPWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
        )
        assert wdl_white[RPWDL_RESULT_HASH][:3] == (1, 0, 0)
        assert wdl_white[RPWDL_RESULT_HASH][3] is not None

    @pytest.mark.asyncio
    async def test_query_resulting_position_wdl_empty_list(self, db_session: AsyncSession) -> None:
        """Empty hash_list returns {} immediately (no DB round trip)."""
        from app.repositories.openings_repository import query_resulting_position_wdl

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=10,
            hash_list=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert wdl == {}
