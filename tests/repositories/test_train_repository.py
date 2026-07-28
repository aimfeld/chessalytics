"""Tests for app.repositories.train_repository's full POOL-07 composition and
D-09/D-10/D-11/D-12 session lifecycle (Phase 189, Plan 04).

Coverage:
- TestComposeSlots                         : compose_slots pure arithmetic (sums to n,
                                              default N=12 -> (9, 3)).
- test_full_session_is_nine_sr_and_three_herrings : the default 75/25 mix with
                                              plenty of material on both sides.
- test_sr_shortfall_backfills_with_herrings / test_herring_shortfall_backfills_with_sr :
                                              honest cross-backfill (Pitfall 4).
- test_padding_introduces_new_drill_items_recency_first : new drill_items come
                                              from the most-recently-played games.
- test_empty_pool_writes_no_session_row    : zero material -> zero puzzles, no
                                              drill_sessions row.
- test_blob_pending_count_reports_waiting_flaws : the thin-pool signal.
- Session lifecycle (D-09/D-10/D-11/D-12)  : resume, expiry, eviction, frozen order.
- test_emptied_blob_item_not_reserved_when_due : 189-06 WR-04 closure — an
                                              already-tracked drill_items row whose
                                              backing flaw's missed_pv_lines became
                                              the D-06 empty-array sentinel is
                                              skipped by due_stmt's fresh scan, not
                                              re-served.

Phase 191 Plan 01 (PROG-01/PROG-04, D-18) — get_progress:
- test_mastered_and_parked_counts_exclude_other_users_rows : the two-user
                                              isolation proof for T-191-01.
- test_first_settlement_replays_pre_existing_history : the all-null D-05
                                              retroactivity case.
- test_progress_read_is_idempotent           : two reads with no new sessions
                                              leave the snapshot byte-identical
                                              (D-18 idempotence).
- test_settled_week_survives_mask_change     : a settled week's judgment
                                              survives a later weekday_mask
                                              change (D-18 regression test).

Data isolation: uses the rollback-scoped ``db_session`` fixture from
tests/conftest.py, following tests/repositories/test_bot_game_settings_repository.py's
precedent — no committed rows leak between tests.
"""

from __future__ import annotations

import datetime
import uuid

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.drill_item import DrillItem, DrillStatus
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillMoveQuality, DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.models.herring_pool import HerringPool
from app.models.train_settings import TrainSettings
from app.repositories import train_repository
from app.services.train_pool import compose_slots
from app.services.train_scheduler import FlameState
from tests.conftest import ensure_test_user

# Unique user ID for this test module (distinct from other repo test modules —
# see test_bot_game_settings_repository.py's 92400 / test_game_repository_persona_wins.py's
# 92401/92402). Every test in this file uses the same rollback-scoped db_session fixture,
# so reuse across test functions within the file is safe.
_USER_ID = 93100
# A second, distinct user for the get_progress cross-user isolation test.
_OTHER_USER_ID = 93101

# A real, legal opening PGN, 20 half-moves — long enough to replay every ply
# this file's fixtures use.
_PGN = (
    "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 "
    "8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *"
)

_MISSED_PV_LINES = [{"b": 40, "bm": None, "s": -30, "sm": None, "su": "g8f6"}]

# A comfortably winnable eval for White (well above WINNABILITY_FLOOR_ES=0.20).
_WINNABLE_CP = 300

_NOW = datetime.datetime(2026, 1, 15, 12, 0, tzinfo=datetime.timezone.utc)
_TODAY = datetime.date(2026, 1, 15)


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


async def _seed_flaw_game(
    db_session: AsyncSession,
    user_id: int,
    label: str,
    *,
    ply: int = 2,
    user_color: str = "white",
    missed_pv_lines: list | None = _MISSED_PV_LINES,
    prior_eval_cp: int | None = _WINNABLE_CP,
    played_at: datetime.datetime | None = None,
) -> int:
    """Seed one game + one qualifying (or blob-pending) blunder flaw row + prior eval."""
    game = Game(
        user_id=user_id,
        platform="lichess",
        platform_game_id=f"{label}-{uuid.uuid4().hex[:8]}",
        platform_url="https://lichess.org/test",
        pgn=_PGN,
        result="1-0",
        user_color=user_color,
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        base_time_seconds=600,
        increment_seconds=0.0,
        rated=True,
        is_computer_game=False,
        ply_count=20,
        full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
        played_at=played_at,
    )
    db_session.add(game)
    await db_session.flush()
    game_id: int = game.id

    flaw_kwargs: dict[str, object] = dict(
        user_id=user_id,
        game_id=game_id,
        ply=ply,
        severity=2,  # blunder
        phase=0,
        is_miss=False,
        is_lucky=False,
        is_reversed=False,
        is_squandered=False,
        fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
    )
    if missed_pv_lines is not None:
        # JSONB gotcha (project_asyncpg_jsonb_null_vs_sql_null): omit the column
        # entirely for a true SQL NULL rather than passing None explicitly.
        flaw_kwargs["missed_pv_lines"] = missed_pv_lines
    db_session.add(GameFlaw(**flaw_kwargs))

    if prior_eval_cp is not None:
        db_session.add(
            GamePosition(
                user_id=user_id,
                game_id=game_id,
                ply=ply - 1,
                full_hash=1_000_000 + game_id * 100 + ply,
                white_hash=2_000_000 + game_id * 100 + ply,
                black_hash=3_000_000 + game_id * 100 + ply,
                eval_cp=prior_eval_cp,
                eval_mate=None,
            )
        )
    await db_session.flush()
    return game_id


async def _seed_herring_game(
    db_session: AsyncSession,
    user_id: int,
    label: str,
    *,
    ply: int = 8,
    user_color: str = "white",
    best_cp: int = 50,
    second_cp: int = 45,
    maia_prob: float = 0.9,
    prior_eval_cp: int | None = 300,
    played_at: datetime.datetime | None = None,
) -> int:
    """Seed one game + one game_best_moves red-herring candidate + prior eval."""
    game = Game(
        user_id=user_id,
        platform="lichess",
        platform_game_id=f"{label}-{uuid.uuid4().hex[:8]}",
        platform_url="https://lichess.org/test",
        pgn=_PGN,
        result="1-0",
        user_color=user_color,
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        base_time_seconds=600,
        increment_seconds=0.0,
        rated=True,
        is_computer_game=False,
        ply_count=20,
        full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
        played_at=played_at,
    )
    db_session.add(game)
    await db_session.flush()
    game_id: int = game.id

    db_session.add(
        GameBestMove(
            game_id=game_id,
            ply=ply,
            maia_prob=maia_prob,
            best_cp=best_cp,
            best_mate=None,
            second_cp=second_cp,
            second_mate=None,
        )
    )
    if prior_eval_cp is not None:
        db_session.add(
            GamePosition(
                user_id=user_id,
                game_id=game_id,
                ply=ply - 1,
                full_hash=4_000_000 + game_id * 100 + ply,
                white_hash=5_000_000 + game_id * 100 + ply,
                black_hash=6_000_000 + game_id * 100 + ply,
                eval_cp=prior_eval_cp,
                eval_mate=None,
            )
        )
    await db_session.flush()
    return game_id


# A default 5-entry MultiPV-5 ladder (white POV, best-first) for pool-row
# fixtures that don't care about the exact ladder shape. Deliberately clears
# BOTH of herring_stmt's Phase 192 (192-04) query-time gates so a fixture
# using this default is, by construction, a valid non-degenerate herring:
# PV0/PV1/PV2 all fall within INACCURACY_DROP (0.05 ES) of PV0 (3 qualifying
# moves, above HERRING_MIN_QUALIFYING_MOVES=2), and PV0-to-PV4 is ~0.092 ES,
# comfortably above HERRING_DEGENERATE_MIN_GAP_ES (0.02).
_DEFAULT_LADDER: list[dict[str, object]] = [
    {"move_uci": "e2e4", "cp": 60, "mate": None},
    {"move_uci": "d2d4", "cp": 45, "mate": None},
    {"move_uci": "g1f3", "cp": 20, "mate": None},
    {"move_uci": "c2c4", "cp": -10, "mate": None},
    {"move_uci": "b1c3", "cp": -40, "mate": None},
]


async def _seed_herring_pool_row(
    db_session: AsyncSession,
    user_id: int,
    label: str,
    *,
    existing_game_id: int | None = None,
    ply: int = 8,
    mover_color: str = "white",
    fen: str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    arriving_move_uci: str | None = "e2e4",
    phase: int = 1,
    played_at: datetime.datetime | None = None,
    ladder: list[dict[str, object]] | None = None,
) -> tuple[int, int]:
    """Seed one `herring_pool` row (Phase 192, sibling to `_seed_herring_game`
    above, which seeds the superseded source and stays where it is until Plan
    04 replaces that block).

    Attaches to `existing_game_id` when given (for own-game-herring collision
    tests, D-10), else creates a fresh `Game` row. Returns `(game_id,
    herring_pool_id)`.
    """
    if existing_game_id is not None:
        game_id = existing_game_id
    else:
        game = Game(
            user_id=user_id,
            platform="lichess",
            platform_game_id=f"{label}-{uuid.uuid4().hex[:8]}",
            platform_url="https://lichess.org/test",
            pgn=_PGN,
            result="1-0",
            user_color="white",
            time_control_str="600+0",
            time_control_bucket="blitz",
            time_control_seconds=600,
            base_time_seconds=600,
            increment_seconds=0.0,
            rated=True,
            is_computer_game=False,
            ply_count=20,
            full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
            played_at=played_at,
        )
        db_session.add(game)
        await db_session.flush()
        game_id = game.id

    row = HerringPool(
        user_id=user_id,
        game_id=game_id,
        ply=ply,
        mover_color=mover_color,
        fen=fen,
        arriving_move_uci=arriving_move_uci,
        phase=phase,
        source_played_at=played_at,
        ladder=ladder if ladder is not None else _DEFAULT_LADDER,
    )
    db_session.add(row)
    await db_session.flush()
    return game_id, row.id


# ---------------------------------------------------------------------------
# TestComposeSlots — pure arithmetic, no DB
# ---------------------------------------------------------------------------


class TestComposeSlots:
    @pytest.mark.parametrize("n", range(1, 21))
    def test_compose_slots_sums_to_n(self, n: int) -> None:
        sr_slots, herring_slots = compose_slots(n)
        assert sr_slots + herring_slots == n

    def test_compose_slots_default_n_is_nine_three(self) -> None:
        assert compose_slots(12) == (9, 3)


# ---------------------------------------------------------------------------
# Composition mix + backfill
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_session_is_nine_sr_and_three_herrings(db_session: AsyncSession) -> None:
    """Plenty of material on both sides -> exactly the 9/3 split at N=12.

    Pins puzzles_per_session=12 explicitly (191-06: DEFAULT_PUZZLES_PER_SESSION
    changed to 6) — this test is about compose_slots' 75/25 mix at a
    specific N, not about the ambient default value, which has its own
    coverage elsewhere (test_get_settings_creates_defaults_on_first_touch).
    """
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_NOW,
    )
    for i in range(12):
        await _seed_flaw_game(db_session, _USER_ID, f"full-sr-{i}")
    for i in range(5):
        await _seed_herring_pool_row(db_session, _USER_ID, f"full-herring-{i}")

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.session_id is not None
    assert composed.puzzle_count == 12
    assert composed.requested_count == 12

    rows = (
        (
            await db_session.execute(
                select(DrillSolve.source).where(DrillSolve.session_id == composed.session_id)
            )
        )
        .scalars()
        .all()
    )
    assert sum(1 for s in rows if s == DrillSource.SR_ITEM) == 9
    assert sum(1 for s in rows if s == DrillSource.RED_HERRING) == 3


@pytest.mark.asyncio
async def test_sr_shortfall_backfills_with_herrings(db_session: AsyncSession) -> None:
    """Too few SR items -> herrings fill the gap up to N.

    Pins puzzles_per_session=12 explicitly (191-06: DEFAULT_PUZZLES_PER_SESSION
    changed to 6) so the SR shortfall this test exercises stays a genuine
    shortfall relative to sr_slots.
    """
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_NOW,
    )
    for i in range(2):
        await _seed_flaw_game(db_session, _USER_ID, f"short-sr-{i}")
    for i in range(15):
        await _seed_herring_pool_row(db_session, _USER_ID, f"short-herring-{i}")

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.session_id is not None
    assert composed.puzzle_count == 12  # full N despite the SR shortfall

    rows = (
        (
            await db_session.execute(
                select(DrillSolve.source).where(DrillSolve.session_id == composed.session_id)
            )
        )
        .scalars()
        .all()
    )
    assert sum(1 for s in rows if s == DrillSource.SR_ITEM) == 2
    assert sum(1 for s in rows if s == DrillSource.RED_HERRING) == 10


@pytest.mark.asyncio
async def test_herring_shortfall_backfills_with_sr(db_session: AsyncSession) -> None:
    """Too few herrings -> SR items fill the gap up to N.

    Pins puzzles_per_session=12 explicitly (191-06: DEFAULT_PUZZLES_PER_SESSION
    changed to 6) so the herring shortfall this test exercises stays a
    genuine shortfall relative to herring_slots.
    """
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_NOW,
    )
    for i in range(15):
        await _seed_flaw_game(db_session, _USER_ID, f"hshort-sr-{i}")
    await _seed_herring_pool_row(db_session, _USER_ID, "hshort-herring-0")

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.session_id is not None
    assert composed.puzzle_count == 12  # full N despite the herring shortfall

    rows = (
        (
            await db_session.execute(
                select(DrillSolve.source).where(DrillSolve.session_id == composed.session_id)
            )
        )
        .scalars()
        .all()
    )
    assert sum(1 for s in rows if s == DrillSource.SR_ITEM) == 11
    assert sum(1 for s in rows if s == DrillSource.RED_HERRING) == 1


@pytest.mark.asyncio
async def test_fully_empty_herring_pool_backfills_with_sr(db_session: AsyncSession) -> None:
    """ROADMAP SC4: with ZERO herring_pool rows (not `test_herring_shortfall_
    backfills_with_sr`'s partial-shortfall ONE), a composed session still
    returns a full N of 100% SR items, `waiting_count` stays honest, and
    neither `herring_stmt` invocation (exclude_served=True, then the
    exclude_served=False fallback) raises on the empty table.

    This is a deliberate sibling, not a rewrite of the partial-shortfall
    test above: that test hits the same cross-backfill branch, but this
    phase swaps the herring source out from under that code path, so the
    zero case deserves its own regression rather than inheriting confidence
    from a test that never exercised zero rows. Per D-13/SEED-120, the
    empty-pool window needs NO new handling in `compose_and_materialize_
    session` — if this test fails, the fix belongs in the source swap, not
    in a new empty-pool special case here.

    Pins puzzles_per_session=12 explicitly (191-06: DEFAULT_PUZZLES_PER_SESSION
    changed to 6) so all 12 SR flaw games seeded below are needed to fill N.
    """
    await ensure_test_user(db_session, _USER_ID)
    settings_row = await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_NOW,
    )
    for i in range(12):
        await _seed_flaw_game(db_session, _USER_ID, f"emptypool-sr-{i}")
    # Deliberately zero herring_pool rows — the case this test exists to pin.

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.session_id is not None
    assert composed.puzzle_count == 12  # full N from SR alone, no herring source at all

    rows = (
        await db_session.execute(
            select(DrillSolve.source, DrillSolve.herring_pool_id).where(
                DrillSolve.session_id == composed.session_id
            )
        )
    ).all()
    assert len(rows) == 12
    assert all(source == DrillSource.SR_ITEM for source, _herring_pool_id in rows)
    assert all(herring_pool_id is None for _source, herring_pool_id in rows)

    # waiting_count must stay honest (neither inflated nor deflated by the
    # absent herring source): the just-composed open session reserved all 12
    # seeded SR puzzles, none solved yet.
    waiting_count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert waiting_count == 12


@pytest.mark.asyncio
async def test_padding_introduces_new_drill_items_recency_first(db_session: AsyncSession) -> None:
    """The newly-tracked drill_items correspond to the most recently played games.

    Pins puzzles_per_session=12 explicitly (191-06: DEFAULT_PUZZLES_PER_SESSION
    changed to 6) — the 9-most-recent/3-oldest split below is keyed to N=12.
    """
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_NOW,
    )
    game_ids: list[int] = []
    base = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    for i in range(12):
        game_id = await _seed_flaw_game(
            db_session,
            _USER_ID,
            f"recency-sr-{i}",
            played_at=base + datetime.timedelta(days=i),  # game 11 is most recent
        )
        game_ids.append(game_id)
    # Enough herring material that the herring side is never short (no SR cross-backfill).
    for i in range(5):
        await _seed_herring_pool_row(db_session, _USER_ID, f"recency-herring-{i}")

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert composed.puzzle_count == 12

    tracked_game_ids = set(
        (await db_session.execute(select(DrillItem.game_id).where(DrillItem.user_id == _USER_ID)))
        .scalars()
        .all()
    )
    expected_tracked = set(game_ids[3:])  # 9 most-recently-played games (indices 3..11)
    excluded = set(game_ids[:3])  # 3 oldest games

    assert tracked_game_ids == expected_tracked
    assert tracked_game_ids.isdisjoint(excluded)


@pytest.mark.asyncio
async def test_empty_pool_writes_no_session_row(db_session: AsyncSession) -> None:
    """Zero qualifying material -> zero puzzles, session_id None, no drill_sessions row."""
    await ensure_test_user(db_session, _USER_ID)

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.session_id is None
    assert composed.puzzle_count == 0
    assert composed.puzzles == []

    session_count = (
        (await db_session.execute(select(DrillSession).where(DrillSession.user_id == _USER_ID)))
        .scalars()
        .all()
    )
    assert session_count == []


@pytest.mark.asyncio
async def test_blob_pending_count_reports_waiting_flaws(db_session: AsyncSession) -> None:
    """A parity-passing, winnability-passing blunder with a NULL blob is counted as
    blob_pending, not served as a puzzle."""
    await ensure_test_user(db_session, _USER_ID)
    game_id = await _seed_flaw_game(db_session, _USER_ID, "pending-1", ply=2, missed_pv_lines=None)

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.blob_pending_count >= 1
    assert (game_id, 2) not in {(p.game_id, p.ply) for p in composed.puzzles}


@pytest.mark.asyncio
async def test_composition_on_off_day_draws_from_same_queue(db_session: AsyncSession) -> None:
    """SCHD-03 (191-04-PLAN.md Task 2): ad-hoc "train now" needs no new
    backend code — neither the fresh-composition path below nor its D-11/
    D-12 guards ever consult `weekday_mask` (189 D-12), so composing on a
    day whose weekday bit is NOT set must draw from the exact same due-item
    + pool queue a scheduled day would use.

    `_NOW`/`_TODAY` (2026-01-15) is a Thursday (`date.weekday() == 3`);
    pinning `weekday_mask` to Monday-only (bit 0) makes today an explicitly
    UNSCHEDULED day for this user."""
    await ensure_test_user(db_session, _USER_ID)
    monday_only_mask = 1 << 0  # Monday only — _TODAY (a Thursday) is off-schedule.
    await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=monday_only_mask,
        puzzles_per_session=12,
        now_utc=_NOW,
    )
    for i in range(9):
        await _seed_flaw_game(db_session, _USER_ID, f"offday-sr-{i}")
    for i in range(5):
        await _seed_herring_pool_row(db_session, _USER_ID, f"offday-herring-{i}")

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.session_id is not None
    assert composed.puzzle_count > 0
    # Identical to the on-schedule test_full_session_is_nine_sr_and_three_herrings
    # mix above — off-day composition draws from the exact same queue, not a
    # degraded or bypassed one.
    assert composed.puzzle_count == 12

    rows = (
        (
            await db_session.execute(
                select(DrillSolve.source).where(DrillSolve.session_id == composed.session_id)
            )
        )
        .scalars()
        .all()
    )
    assert sum(1 for s in rows if s == DrillSource.SR_ITEM) == 9
    assert sum(1 for s in rows if s == DrillSource.RED_HERRING) == 3


# ---------------------------------------------------------------------------
# Herring source swap (Phase 192, D-03/D-04/D-10) — 192-01-PLAN.md Task 2
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_herring_fen_comes_from_pool_row_not_pgn(db_session: AsyncSession) -> None:
    """D-03: a herring's FEN and arriving move are read straight off the
    `herring_pool` row, never re-derived from the source game's PGN.

    Seeds a pool row whose `fen` deliberately does NOT match what the game's
    PGN would produce at that ply — if composition ever fell back to
    `fen_and_last_move_at_ply`, this assertion would catch it.
    """
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=1,
        now_utc=_NOW,
    )
    deliberately_wrong_fen = "8/8/8/8/8/8/8/K6k w - - 0 1"
    _game_id, pool_id = await _seed_herring_pool_row(
        db_session,
        _USER_ID,
        "fen-mismatch",
        fen=deliberately_wrong_fen,
        arriving_move_uci="a1a2",
    )

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert composed.puzzle_count == 1
    puzzle = composed.puzzles[0]
    assert puzzle.fen == deliberately_wrong_fen
    assert puzzle.last_move_uci == "a1a2"
    assert puzzle.herring_pool_id == pool_id

    stored_herring_pool_id = (
        await db_session.execute(
            select(DrillSolve.herring_pool_id).where(DrillSolve.session_id == composed.session_id)
        )
    ).scalar_one()
    assert stored_herring_pool_id == pool_id


@pytest.mark.asyncio
async def test_own_game_herring_colliding_with_sr_pick_is_dropped(db_session: AsyncSession) -> None:
    """D-10: an own-game herring is permitted, but when its `(game_id, ply)`
    matches an SR pick already selected for this session, the herring is
    dropped before insert — `uq_drill_solves_session_puzzle` never fires and
    the SR row wins the slot.
    """
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=4,
        now_utc=_NOW,
    )
    game_id = await _seed_flaw_game(db_session, _USER_ID, "collide-sr", ply=2)
    await _seed_herring_pool_row(
        db_session, _USER_ID, "collide-herring", existing_game_id=game_id, ply=2
    )

    composed = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    # Only the SR row survives — the colliding herring was dropped, not both
    # inserted (which would have raised IntegrityError on the unique index).
    assert composed.puzzle_count == 1
    rows = (
        await db_session.execute(
            select(DrillSolve.source, DrillSolve.herring_pool_id).where(
                DrillSolve.session_id == composed.session_id
            )
        )
    ).all()
    assert len(rows) == 1
    source, herring_pool_id = rows[0]
    assert source == DrillSource.SR_ITEM
    assert herring_pool_id is None


# ---------------------------------------------------------------------------
# Session lifecycle — resume, expire, freeze, evict (D-09/D-10/D-11/D-12)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_second_compose_resumes_open_session(db_session: AsyncSession) -> None:
    await ensure_test_user(db_session, _USER_ID)
    await _seed_flaw_game(db_session, _USER_ID, "resume-1")

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.session_id is not None
    assert first.puzzle_count == 1
    assert len(first.puzzles) == 1

    second = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert second.session_id == first.session_id
    assert [(p.game_id, p.ply) for p in second.puzzles] == [
        (p.game_id, p.ply) for p in first.puzzles
    ]

    # Mark the only puzzle solved, then recompose again (still resumes the same
    # open session) — the solved puzzle is excluded from the returned list.
    await db_session.execute(
        update(DrillSolve)
        .where(DrillSolve.session_id == first.session_id, DrillSolve.position == 0)
        .values(solved_at=_NOW, correct_move=True)
    )
    await db_session.flush()

    third = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert third.session_id == first.session_id
    assert third.puzzles == []
    assert third.solved_count == 1


@pytest.mark.asyncio
async def test_completed_session_in_window_blocks_recompose(db_session: AsyncSession) -> None:
    """190.1 bug fix: finishing a session must not unlock a fresh one within
    the same D-10 window. A `status='completed'` row is invisible to the
    open-session resume path, so before the `completed_session_in_window`
    guard the very next compose call built a brand-new session on the same
    day (unlimited sessions per day, pool drained)."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_flaw_game(db_session, _USER_ID, "completed-window-1")

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.session_id is not None
    assert first.puzzle_count == 1

    # Solve the only puzzle and complete the session — the exact state
    # `_mark_session_complete_if_done` leaves behind after the last solve.
    await db_session.execute(
        update(DrillSolve)
        .where(DrillSolve.session_id == first.session_id)
        .values(solved_at=_NOW, correct_move=True)
    )
    await db_session.execute(
        update(DrillSession)
        .where(DrillSession.id == first.session_id)
        .values(status="completed", completed_at=_NOW)
    )
    await db_session.flush()

    # Fresh material IS available — without the guard this composes a
    # brand-new session from it instead of returning the completed one.
    await _seed_flaw_game(db_session, _USER_ID, "completed-window-2")

    second = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert second.session_id == first.session_id
    assert second.puzzles == []
    assert second.solved_count == 1
    assert second.puzzle_count == 1

    session_ids = (
        (await db_session.execute(select(DrillSession.id).where(DrillSession.user_id == _USER_ID)))
        .scalars()
        .all()
    )
    assert session_ids == [first.session_id]


@pytest.mark.asyncio
async def test_completed_session_past_window_recomposes(db_session: AsyncSession) -> None:
    """The completed-session guard only holds inside the D-10 window: once
    `expires_on` arrives, compose builds the next session normally."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_flaw_game(db_session, _USER_ID, "completed-expired-1")

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.session_id is not None

    await db_session.execute(
        update(DrillSolve)
        .where(DrillSolve.session_id == first.session_id)
        .values(solved_at=_NOW, correct_move=True)
    )
    await db_session.execute(
        update(DrillSession)
        .where(DrillSession.id == first.session_id)
        .values(status="completed", completed_at=_NOW, expires_on=datetime.date(2020, 1, 1))
    )
    await db_session.flush()

    await _seed_flaw_game(db_session, _USER_ID, "completed-expired-2")

    second = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert second.session_id is not None
    assert second.session_id != first.session_id
    assert second.puzzle_count >= 1


@pytest.mark.asyncio
async def test_integrity_error_race_resumes_winner_session(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T-189-14: a race where the D-12 fast-path check misses a concurrent
    winner's already-open session is caught via uq_drill_sessions_user_open
    at insert time and resumed rather than raised.

    Deterministic (no real concurrency needed): a winner's open session is
    seeded directly, `open_session_for_user`'s FIRST call is monkeypatched to
    return None (simulating the exact race window this guard exists for) so
    composition proceeds into a fresh `DrillSession` insert on the SAME
    connection — which then genuinely collides with the winner's row on the
    partial unique index, proving the `except IntegrityError` branch (not
    just the D-12 pre-check) is what resumes the winner.
    """
    await ensure_test_user(db_session, _USER_ID)
    game_id = await _seed_flaw_game(db_session, _USER_ID, "race-1")

    winner_session = DrillSession(
        user_id=_USER_ID,
        session_date=_TODAY,
        status="open",
        puzzle_count=1,
        expires_on=_TODAY + datetime.timedelta(days=1),
    )
    db_session.add(winner_session)
    await db_session.flush()
    db_session.add(
        DrillSolve(
            session_id=winner_session.id,
            position=0,
            user_id=_USER_ID,
            game_id=game_id,
            ply=2,
            source=DrillSource.SR_ITEM,
            solved_at=None,
        )
    )
    await db_session.flush()

    real_open_session_for_user = train_repository.open_session_for_user
    call_count = {"n": 0}

    async def _flaky_check(session: AsyncSession, *, user_id: int) -> DrillSession | None:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return None  # simulate the race window: miss the winner's session
        return await real_open_session_for_user(session, user_id=user_id)

    monkeypatch.setattr(train_repository, "open_session_for_user", _flaky_check)

    result = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    assert result.session_id == winner_session.id
    assert call_count["n"] == 2  # the pre-check miss, then the except-branch re-fetch

    open_rows = (
        (
            await db_session.execute(
                select(DrillSession).where(
                    DrillSession.user_id == _USER_ID, DrillSession.status == "open"
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(open_rows) == 1  # the failed composition never left a second open row


@pytest.mark.asyncio
async def test_expired_session_is_marked_and_recomposed(db_session: AsyncSession) -> None:
    await ensure_test_user(db_session, _USER_ID)
    await _seed_flaw_game(db_session, _USER_ID, "expire-recompose-1")

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.session_id is not None

    await db_session.execute(
        update(DrillSession)
        .where(DrillSession.id == first.session_id)
        .values(expires_on=datetime.date(2020, 1, 1))
    )
    await db_session.flush()

    second = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )

    old_row = (
        await db_session.execute(select(DrillSession).where(DrillSession.id == first.session_id))
    ).scalar_one()
    assert old_row.status == "expired"
    assert second.session_id is not None
    assert second.session_id != first.session_id


@pytest.mark.asyncio
async def test_expired_session_keeps_recorded_solves(db_session: AsyncSession) -> None:
    await ensure_test_user(db_session, _USER_ID)
    await _seed_flaw_game(db_session, _USER_ID, "expire-keep-solve-1")

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.session_id is not None

    await db_session.execute(
        update(DrillSolve)
        .where(DrillSolve.session_id == first.session_id, DrillSolve.position == 0)
        .values(solved_at=_NOW, correct_move=True, played_move="e2e4")
    )
    await db_session.execute(
        update(DrillSession)
        .where(DrillSession.id == first.session_id)
        .values(expires_on=datetime.date(2020, 1, 1))
    )
    await db_session.flush()

    await train_repository.expire_stale_sessions(db_session, user_id=_USER_ID, today=_TODAY)
    await db_session.flush()

    solve_row = (
        await db_session.execute(
            select(DrillSolve).where(
                DrillSolve.session_id == first.session_id, DrillSolve.position == 0
            )
        )
    ).scalar_one()
    assert solve_row.solved_at is not None
    assert solve_row.correct_move is True
    assert solve_row.played_move == "e2e4"


@pytest.mark.asyncio
async def test_unsolved_items_stay_due_after_expiry(db_session: AsyncSession) -> None:
    await ensure_test_user(db_session, _USER_ID)
    game_id = await _seed_flaw_game(db_session, _USER_ID, "expire-due-1", ply=2)

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.session_id is not None

    item_before = (
        await db_session.execute(
            select(DrillItem).where(
                DrillItem.user_id == _USER_ID, DrillItem.game_id == game_id, DrillItem.ply == 2
            )
        )
    ).scalar_one()
    due_before = item_before.due_date

    await db_session.execute(
        update(DrillSession)
        .where(DrillSession.id == first.session_id)
        .values(expires_on=datetime.date(2020, 1, 1))
    )
    await db_session.flush()
    await train_repository.expire_stale_sessions(db_session, user_id=_USER_ID, today=_TODAY)
    await db_session.flush()

    item_after = (
        await db_session.execute(
            select(DrillItem).where(
                DrillItem.user_id == _USER_ID, DrillItem.game_id == game_id, DrillItem.ply == 2
            )
        )
    ).scalar_one()
    assert item_after.due_date == due_before


@pytest.mark.asyncio
async def test_evicted_item_is_skipped_on_resume(db_session: AsyncSession) -> None:
    await ensure_test_user(db_session, _USER_ID)
    game_id = await _seed_flaw_game(db_session, _USER_ID, "evict-1", ply=2)

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.puzzle_count == 1

    # Simulate a reclassification that removes the backing flaw row mid-window.
    await db_session.execute(
        delete(GameFlaw).where(
            GameFlaw.user_id == _USER_ID, GameFlaw.game_id == game_id, GameFlaw.ply == 2
        )
    )
    await db_session.flush()

    second = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert second.session_id == first.session_id
    assert second.puzzles == []  # skipped, never served broken
    assert second.puzzle_count == first.puzzle_count  # frozen count unchanged

    item_row = (
        await db_session.execute(
            select(DrillItem).where(
                DrillItem.user_id == _USER_ID, DrillItem.game_id == game_id, DrillItem.ply == 2
            )
        )
    ).scalar_one_or_none()
    assert item_row is not None  # skipped, not deleted


@pytest.mark.asyncio
async def test_emptied_blob_item_not_reserved_when_due(db_session: AsyncSession) -> None:
    """189-06 WR-04 closure: an already-tracked drill_items row whose backing
    flaw's missed_pv_lines was reset to the D-06 empty-array sentinel is
    skipped by due_stmt's fresh scan on the next session compose (isolates
    due_stmt specifically — pool_entry_stmt's padding scan already skips
    tracked items via existing_pairs regardless of this fix)."""
    await ensure_test_user(db_session, _USER_ID)
    game_id = await _seed_flaw_game(db_session, _USER_ID, "emptied-blob-1", ply=2)

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert first.puzzle_count == 1

    # Force the session to expire so the NEXT compose runs a fresh due_stmt
    # scan rather than resuming (resume/load_session_puzzles is a distinct
    # code path already covered by test_evicted_item_is_skipped_on_resume).
    await db_session.execute(
        update(DrillSession)
        .where(DrillSession.id == first.session_id)
        .values(expires_on=datetime.date(2020, 1, 1))
    )
    await db_session.flush()

    # Simulate a re-blob that came back un-fillable: the D-06 sentinel.
    await db_session.execute(
        update(GameFlaw)
        .where(GameFlaw.user_id == _USER_ID, GameFlaw.game_id == game_id, GameFlaw.ply == 2)
        .values(missed_pv_lines=[])
    )
    await db_session.flush()

    second = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    assert second.puzzle_count == 0

    item_row = (
        await db_session.execute(
            select(DrillItem).where(
                DrillItem.user_id == _USER_ID, DrillItem.game_id == game_id, DrillItem.ply == 2
            )
        )
    ).scalar_one()
    assert item_row.status == DrillStatus.ACTIVE  # skipped, never deleted or parked


@pytest.mark.asyncio
async def test_frozen_order_is_stable_across_resumes(db_session: AsyncSession) -> None:
    await ensure_test_user(db_session, _USER_ID)
    for i in range(4):
        await _seed_flaw_game(db_session, _USER_ID, f"frozen-sr-{i}")
    for i in range(2):
        await _seed_herring_pool_row(db_session, _USER_ID, f"frozen-herring-{i}")

    first = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    order_first = [(p.position, p.game_id, p.ply) for p in first.puzzles]
    assert len(order_first) == 6

    second = await train_repository.compose_and_materialize_session(
        db_session, user_id=_USER_ID, now_utc=_NOW
    )
    order_second = [(p.position, p.game_id, p.ply) for p in second.puzzles]

    assert order_first == order_second


# ---------------------------------------------------------------------------
# D-05 nullability (Phase 192, Plan 02) — orphaned SR vs orphaned herring
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resume_serves_herring_with_deleted_source_game(db_session: AsyncSession) -> None:
    """D-01/D-05: a herring whose source game has been deleted is still
    served on resume, FEN/arriving move read off its `herring_pool` row
    (D-03) — `game_id` is nulled via the real `ON DELETE SET NULL` FK policy,
    never dropped, never crashing.
    """
    await ensure_test_user(db_session, _USER_ID)
    deliberately_wrong_fen = "8/8/8/8/8/8/8/K6k w - - 0 1"
    game_id, pool_id = await _seed_herring_pool_row(
        db_session,
        _USER_ID,
        "orphan-herring",
        ply=8,
        fen=deliberately_wrong_fen,
        arriving_move_uci="a1a2",
    )
    drill_session = DrillSession(
        user_id=_USER_ID,
        session_date=_TODAY,
        status="open",
        puzzle_count=1,
        expires_on=_TODAY + datetime.timedelta(days=7),
    )
    db_session.add(drill_session)
    await db_session.flush()
    db_session.add(
        DrillSolve(
            session_id=drill_session.id,
            position=0,
            user_id=_USER_ID,
            game_id=game_id,
            ply=8,
            source=DrillSource.RED_HERRING,
            herring_pool_id=pool_id,
            solved_at=None,
        )
    )
    await db_session.flush()

    # Delete the source game and let the real ON DELETE SET NULL FK policy
    # act — never null the column by hand, which would prove nothing about
    # the actual migration.
    await db_session.execute(delete(Game).where(Game.id == game_id))
    await db_session.flush()

    puzzles = await train_repository.load_session_puzzles(
        db_session, user_id=_USER_ID, session_id=drill_session.id
    )

    assert len(puzzles) == 1
    puzzle = puzzles[0]
    assert puzzle.game_id is None  # nulled by ON DELETE SET NULL, row survives
    assert puzzle.fen == deliberately_wrong_fen  # off the pool row, not a PGN
    assert puzzle.last_move_uci == "a1a2"
    assert puzzle.herring_pool_id == pool_id


@pytest.mark.asyncio
async def test_completion_ignores_orphaned_sr_row_but_counts_orphaned_herring(
    db_session: AsyncSession,
) -> None:
    """Two sides of the same `or_` clause in `_mark_session_complete_if_done`:

    - An orphaned SR row (source game deleted) is EXCLUDED from `remaining` —
      it can never be attempted again, so it must not block completion
      (the exact pre-D-05 CASCADE-deletion outcome, preserved via lazy
      exclusion instead of a deleted row; this is the WR-02 stuck-session
      fix, extended to also cover "game row gone").
    - An orphaned herring row (source game ALSO deleted) is NOT excluded —
      it is still perfectly servable off its `herring_pool` row (D-03) and
      must keep pinning the session open until solved.

    A session with only these two rows must therefore stay open — handling
    only one side (the documented failure mode) would make it wrongly
    complete or wrongly stuck forever.
    """
    await ensure_test_user(db_session, _USER_ID)
    sr_game_id = await _seed_flaw_game(db_session, _USER_ID, "orphan-sr", ply=2)
    herring_game_id, pool_id = await _seed_herring_pool_row(
        db_session, _USER_ID, "orphan-herring-completion", ply=8
    )

    drill_session = DrillSession(
        user_id=_USER_ID,
        session_date=_TODAY,
        status="open",
        puzzle_count=2,
        expires_on=_TODAY + datetime.timedelta(days=7),
    )
    db_session.add(drill_session)
    await db_session.flush()
    db_session.add(
        DrillSolve(
            session_id=drill_session.id,
            position=0,
            user_id=_USER_ID,
            game_id=sr_game_id,
            ply=2,
            source=DrillSource.SR_ITEM,
            solved_at=None,
        )
    )
    db_session.add(
        DrillSolve(
            session_id=drill_session.id,
            position=1,
            user_id=_USER_ID,
            game_id=herring_game_id,
            ply=8,
            source=DrillSource.RED_HERRING,
            herring_pool_id=pool_id,
            solved_at=None,
        )
    )
    await db_session.flush()

    # Delete BOTH source games via the real FK policy — never null by hand.
    await db_session.execute(delete(Game).where(Game.id.in_([sr_game_id, herring_game_id])))
    await db_session.flush()

    session_complete = await train_repository._mark_session_complete_if_done(
        db_session, session_id=drill_session.id, now_utc=_NOW
    )

    # The orphaned herring alone keeps `remaining` at 1 — the session must
    # NOT complete, even though the orphaned SR row is excluded.
    assert session_complete is False
    status = (
        await db_session.execute(
            select(DrillSession.status).where(DrillSession.id == drill_session.id)
        )
    ).scalar_one()
    assert status == "open"

    # Directly prove the SR-vs-herring asymmetry the docstring promises: mark
    # the still-servable herring solved and confirm the SR orphan alone no
    # longer blocks completion.
    await db_session.execute(
        update(DrillSolve)
        .where(DrillSolve.session_id == drill_session.id, DrillSolve.position == 1)
        .values(solved_at=_NOW, correct_move=True)
    )
    await db_session.flush()

    session_complete_after = await train_repository._mark_session_complete_if_done(
        db_session, session_id=drill_session.id, now_utc=_NOW
    )
    assert session_complete_after is True


# ---------------------------------------------------------------------------
# get_waiting_puzzle_count (Phase 191 Plan 02, Task 1)
# ---------------------------------------------------------------------------


async def _seed_bare_game(db_session: AsyncSession, user_id: int, label: str) -> int:
    """Seed a Game row with no flaw/best-move rows attached — never counted as
    pool material, so it's safe to back drill_solves fixtures with it."""
    game = Game(
        user_id=user_id,
        platform="lichess",
        platform_game_id=f"{label}-{uuid.uuid4().hex[:8]}",
        platform_url="https://lichess.org/test",
        pgn=_PGN,
        result="1-0",
        user_color="white",
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        base_time_seconds=600,
        increment_seconds=0.0,
        rated=True,
        is_computer_game=False,
        ply_count=20,
        full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
    )
    db_session.add(game)
    await db_session.flush()
    game_id: int = game.id
    return game_id


async def _seed_open_session_with_solves(
    db_session: AsyncSession,
    user_id: int,
    label: str,
    *,
    puzzle_count: int,
    solved_count: int,
    expires_on: datetime.date,
) -> DrillSession:
    """Seed one open drill_sessions row + puzzle_count unsolved/solved drill_solves rows.

    Backed by a bare game (no flaw row) so this fixture never contributes
    extra `pool_entry_stmt` material of its own.
    """
    game_id = await _seed_bare_game(db_session, user_id, label)
    drill_session = DrillSession(
        user_id=user_id,
        session_date=_TODAY,
        status="open",
        puzzle_count=puzzle_count,
        expires_on=expires_on,
    )
    db_session.add(drill_session)
    await db_session.flush()
    for i in range(puzzle_count):
        db_session.add(
            DrillSolve(
                session_id=drill_session.id,
                position=i,
                user_id=user_id,
                game_id=game_id,
                ply=i,
                source=DrillSource.SR_ITEM,
                solved_at=_NOW if i < solved_count else None,
            )
        )
    await db_session.flush()
    return drill_session


@pytest.mark.asyncio
async def test_waiting_count_zero_with_no_material(db_session: AsyncSession) -> None:
    """No sessions, no material -> 0."""
    await ensure_test_user(db_session, _USER_ID)
    settings_row = await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)

    count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert count == 0


@pytest.mark.asyncio
async def test_waiting_count_open_unexpired_session_subtracts_solved(
    db_session: AsyncSession,
) -> None:
    """Open unexpired session, puzzle_count=12, 5 solved -> 7."""
    await ensure_test_user(db_session, _USER_ID)
    settings_row = await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)
    await _seed_open_session_with_solves(
        db_session,
        _USER_ID,
        "waiting-open",
        puzzle_count=12,
        solved_count=5,
        expires_on=_TODAY + datetime.timedelta(days=1),
    )

    count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert count == 7


@pytest.mark.asyncio
async def test_waiting_count_expired_open_session_ignored_and_not_flipped(
    db_session: AsyncSession,
) -> None:
    """An open session whose expires_on is on/before today is ignored -> the
    fresh-material estimate is used, and the row's status stays 'open'."""
    await ensure_test_user(db_session, _USER_ID)
    settings_row = await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)
    drill_session = await _seed_open_session_with_solves(
        db_session,
        _USER_ID,
        "waiting-expired",
        puzzle_count=3,
        solved_count=0,
        expires_on=_TODAY,  # today >= expires_on -> expired
    )
    await _seed_flaw_game(db_session, _USER_ID, "waiting-expired-fresh")

    count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert count == 1  # the fresh-material estimate, never derived from the expired session

    row = (
        await db_session.execute(select(DrillSession).where(DrillSession.id == drill_session.id))
    ).scalar_one()
    assert row.status == "open"  # the read never flips it


@pytest.mark.asyncio
async def test_waiting_count_completed_session_in_window_returns_zero(
    db_session: AsyncSession,
) -> None:
    """A completed session still inside its D-10 window -> 0 (D-07)."""
    await ensure_test_user(db_session, _USER_ID)
    settings_row = await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)
    db_session.add(
        DrillSession(
            user_id=_USER_ID,
            session_date=_TODAY,
            status="completed",
            puzzle_count=1,
            expires_on=_TODAY + datetime.timedelta(days=1),
            completed_at=_NOW,
        )
    )
    await db_session.flush()

    count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert count == 0


@pytest.mark.asyncio
async def test_waiting_count_no_session_caps_at_puzzles_per_session(
    db_session: AsyncSession,
) -> None:
    """No session in window with 20 eligible due items and puzzles_per_session=12 -> 12."""
    await ensure_test_user(db_session, _USER_ID)
    settings_row = await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_NOW,
    )
    for i in range(20):
        game_id = await _seed_flaw_game(db_session, _USER_ID, f"waiting-cap-{i}")
        db_session.add(
            DrillItem(
                user_id=_USER_ID,
                game_id=game_id,
                ply=2,
                status=DrillStatus.ACTIVE,
                streak=0,
                due_date=_TODAY,
                fail_count=0,
                ever_correct=False,
            )
        )
    await db_session.flush()

    count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert count == 12


@pytest.mark.asyncio
async def test_waiting_count_never_writes_a_session_or_solve_row(
    db_session: AsyncSession,
) -> None:
    """Row-count invariant: drill_sessions/drill_solves counts are unchanged
    across the call, in the fresh-material case (191-RESEARCH.md Pitfall 1)."""
    await ensure_test_user(db_session, _USER_ID)
    settings_row = await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)
    await _seed_flaw_game(db_session, _USER_ID, "waiting-invariant")

    sessions_before = (
        await db_session.execute(select(func.count()).select_from(DrillSession))
    ).scalar_one()
    solves_before = (
        await db_session.execute(select(func.count()).select_from(DrillSolve))
    ).scalar_one()

    count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert count == 1

    sessions_after = (
        await db_session.execute(select(func.count()).select_from(DrillSession))
    ).scalar_one()
    solves_after = (
        await db_session.execute(select(func.count()).select_from(DrillSolve))
    ).scalar_one()
    assert sessions_after == sessions_before
    assert solves_after == solves_before


@pytest.mark.asyncio
async def test_waiting_count_scoped_to_caller_user(db_session: AsyncSession) -> None:
    """Another user's open session and due items never change the caller's count."""
    await ensure_test_user(db_session, _USER_ID)
    await ensure_test_user(db_session, _OTHER_USER_ID)
    settings_row = await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)

    await _seed_open_session_with_solves(
        db_session,
        _OTHER_USER_ID,
        "waiting-scope-other-open",
        puzzle_count=5,
        solved_count=0,
        expires_on=_TODAY + datetime.timedelta(days=1),
    )
    for i in range(3):
        game_id = await _seed_flaw_game(db_session, _OTHER_USER_ID, f"waiting-scope-other-{i}")
        db_session.add(
            DrillItem(
                user_id=_OTHER_USER_ID,
                game_id=game_id,
                ply=2,
                status=DrillStatus.ACTIVE,
                streak=0,
                due_date=_TODAY,
                fail_count=0,
                ever_correct=False,
            )
        )
    await db_session.flush()

    count = await train_repository.get_waiting_puzzle_count(
        db_session, user_id=_USER_ID, settings_row=settings_row, today=_TODAY
    )
    assert count == 0


# ---------------------------------------------------------------------------
# get_progress (PROG-01/PROG-04, Phase 191 Plan 01, D-18)
# ---------------------------------------------------------------------------

# 2026-01-15 is a Thursday; its week starts Monday 2026-01-12 ("current
# week" for these tests). 2026-01-05 (Monday) is a fully-elapsed past week.
_PROGRESS_NOW = datetime.datetime(2026, 1, 15, 12, 0, tzinfo=datetime.timezone.utc)
_PROGRESS_PAST_WEEK_MONDAY = datetime.date(2026, 1, 5)


async def _seed_completed_session(
    db_session: AsyncSession, user_id: int, session_date: datetime.date
) -> None:
    """Seed a bare `status='completed'` `drill_sessions` row on a given date.

    `get_progress`/`settle_streak_snapshot` only reads `session_date` off
    `status='completed'` rows — no `drill_solves` rows are needed to exercise
    the streak replay.
    """
    db_session.add(
        DrillSession(
            user_id=user_id,
            session_date=session_date,
            status="completed",
            puzzle_count=1,
            expires_on=session_date + datetime.timedelta(days=1),
            completed_at=datetime.datetime.combine(
                session_date, datetime.time(12, 0), tzinfo=datetime.timezone.utc
            ),
        )
    )
    await db_session.flush()


async def _seed_drill_item_with_status(
    db_session: AsyncSession, user_id: int, label: str, *, status: DrillStatus
) -> None:
    """Seed one drill_items row in a given terminal status (mastered/parked)."""
    game_id = await _seed_flaw_game(db_session, user_id, label)
    db_session.add(
        DrillItem(
            user_id=user_id,
            game_id=game_id,
            ply=2,
            status=int(status),
            streak=0,
            due_date=_TODAY,
            fail_count=0,
            ever_correct=(status == DrillStatus.MASTERED),
        )
    )
    await db_session.flush()


@pytest.mark.asyncio
async def test_mastered_and_parked_counts_exclude_other_users_rows(
    db_session: AsyncSession,
) -> None:
    """T-191-01: mastered_count/parked_count are scoped strictly to user_id."""
    await ensure_test_user(db_session, _USER_ID)
    await ensure_test_user(db_session, _OTHER_USER_ID)

    await _seed_drill_item_with_status(
        db_session, _USER_ID, "progress-mine-mastered", status=DrillStatus.MASTERED
    )
    await _seed_drill_item_with_status(
        db_session, _USER_ID, "progress-mine-parked", status=DrillStatus.PARKED
    )
    # The other user has TWICE as many mastered/parked rows — if the query
    # were unscoped, these counts would leak into _USER_ID's totals.
    await _seed_drill_item_with_status(
        db_session, _OTHER_USER_ID, "progress-other-mastered-1", status=DrillStatus.MASTERED
    )
    await _seed_drill_item_with_status(
        db_session, _OTHER_USER_ID, "progress-other-mastered-2", status=DrillStatus.MASTERED
    )
    await _seed_drill_item_with_status(
        db_session, _OTHER_USER_ID, "progress-other-parked-1", status=DrillStatus.PARKED
    )
    await _seed_drill_item_with_status(
        db_session, _OTHER_USER_ID, "progress-other-parked-2", status=DrillStatus.PARKED
    )

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.mastered_count == 1
    assert progress.parked_count == 1


@pytest.mark.asyncio
async def test_pool_state_no_material_when_nothing_exists(db_session: AsyncSession) -> None:
    """Zero drill_items, zero pool_entry_stmt candidates, zero blob-pending -> no_material."""
    await ensure_test_user(db_session, _USER_ID)

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.pool_state == "no_material"
    assert progress.waiting_count == 0
    assert progress.next_due_date is None


@pytest.mark.asyncio
async def test_pool_state_exhausted_when_only_mastered_items_remain(
    db_session: AsyncSession,
) -> None:
    """Mastered-only drill_items, waiting_count 0, blob-pending 0 -> exhausted."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_drill_item_with_status(
        db_session, _USER_ID, "pool-state-mastered", status=DrillStatus.MASTERED
    )

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.waiting_count == 0
    assert progress.pool_state == "exhausted"


@pytest.mark.asyncio
async def test_pool_state_available_with_eligible_due_material(db_session: AsyncSession) -> None:
    """Eligible due material -> available."""
    await ensure_test_user(db_session, _USER_ID)
    game_id = await _seed_flaw_game(db_session, _USER_ID, "pool-state-available")
    db_session.add(
        DrillItem(
            user_id=_USER_ID,
            game_id=game_id,
            ply=2,
            status=DrillStatus.ACTIVE,
            streak=0,
            due_date=_TODAY,
            fail_count=0,
            ever_correct=False,
        )
    )
    await db_session.flush()

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.waiting_count >= 1
    assert progress.pool_state == "available"


@pytest.mark.asyncio
async def test_pool_state_available_when_blob_pending_and_no_drill_items(
    db_session: AsyncSession,
) -> None:
    """Zero drill_items but a non-zero blob-pending count -> available (still
    catching up, not a cold start)."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_flaw_game(db_session, _USER_ID, "pool-state-pending", missed_pv_lines=None)

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.pool_state == "available"


@pytest.mark.asyncio
async def test_next_due_date_is_min_future_due_date_of_active_items(
    db_session: AsyncSession,
) -> None:
    """next_due_date is the minimum due_date among ACTIVE items with due_date > today;
    an ACTIVE item due today or earlier does not set it."""
    await ensure_test_user(db_session, _USER_ID)
    game_today = await _seed_flaw_game(db_session, _USER_ID, "next-due-today")
    game_soon = await _seed_flaw_game(db_session, _USER_ID, "next-due-soon")
    game_later = await _seed_flaw_game(db_session, _USER_ID, "next-due-later")
    db_session.add_all(
        [
            DrillItem(
                user_id=_USER_ID,
                game_id=game_today,
                ply=2,
                status=DrillStatus.ACTIVE,
                streak=0,
                due_date=_PROGRESS_NOW.date(),
                fail_count=0,
                ever_correct=False,
            ),
            DrillItem(
                user_id=_USER_ID,
                game_id=game_soon,
                ply=2,
                status=DrillStatus.ACTIVE,
                streak=0,
                due_date=_PROGRESS_NOW.date() + datetime.timedelta(days=3),
                fail_count=0,
                ever_correct=False,
            ),
            DrillItem(
                user_id=_USER_ID,
                game_id=game_later,
                ply=2,
                status=DrillStatus.ACTIVE,
                streak=0,
                due_date=_PROGRESS_NOW.date() + datetime.timedelta(days=10),
                fail_count=0,
                ever_correct=False,
            ),
        ]
    )
    await db_session.flush()

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.next_due_date == _PROGRESS_NOW.date() + datetime.timedelta(days=3)


@pytest.mark.asyncio
async def test_next_due_date_is_none_with_no_future_active_item(db_session: AsyncSession) -> None:
    """next_due_date is None when the user has no ACTIVE item with a future due date."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_drill_item_with_status(
        db_session, _USER_ID, "next-due-none-mastered", status=DrillStatus.MASTERED
    )

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.next_due_date is None


@pytest.mark.asyncio
async def test_first_settlement_replays_pre_existing_history(db_session: AsyncSession) -> None:
    """D-05 retroactivity, preserved under D-18: a brand-new all-null
    snapshot replays the user's entire pre-existing completed-session
    history on the very first GET /train/progress."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_completed_session(db_session, _USER_ID, _PROGRESS_PAST_WEEK_MONDAY)

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert progress.settled_streak_weeks == 1
    assert progress.flame_state == FlameState.MINIMUM.value

    row = (
        await db_session.execute(select(TrainSettings).where(TrainSettings.user_id == _USER_ID))
    ).scalar_one()
    assert row.streak_settled_through == _PROGRESS_PAST_WEEK_MONDAY
    assert row.streak_count == 1


@pytest.mark.asyncio
async def test_progress_read_is_idempotent(db_session: AsyncSession) -> None:
    """D-18 idempotence: two reads with no new sessions leave streak_count,
    flame_state and streak_settled_through byte-identical on the row."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_completed_session(db_session, _USER_ID, _PROGRESS_PAST_WEEK_MONDAY)

    await train_repository.get_progress(db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW)
    first_row = (
        await db_session.execute(select(TrainSettings).where(TrainSettings.user_id == _USER_ID))
    ).scalar_one()
    first = (first_row.streak_count, first_row.flame_state, first_row.streak_settled_through)

    await train_repository.get_progress(db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW)
    second_row = (
        await db_session.execute(select(TrainSettings).where(TrainSettings.user_id == _USER_ID))
    ).scalar_one()
    second = (second_row.streak_count, second_row.flame_state, second_row.streak_settled_through)

    assert first == second


@pytest.mark.asyncio
async def test_settled_week_survives_mask_change(db_session: AsyncSession) -> None:
    """D-18 regression test: a settled week's judgment is unchanged by a
    later weekday_mask change (via PUT-equivalent direct row update, since
    Plan 04 wires the actual settle-before-mutate PUT path)."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_completed_session(db_session, _USER_ID, _PROGRESS_PAST_WEEK_MONDAY)

    first = await train_repository.get_progress(db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW)
    assert first.settled_streak_weeks == 1
    assert first.flame_state == FlameState.MINIMUM.value

    # Change the mask to one that would have judged the ALREADY-SETTLED week
    # differently (3 scheduled days, but only 1 session was ever recorded).
    three_bit_mask = (1 << 0) | (1 << 2) | (1 << 4)
    await db_session.execute(
        update(TrainSettings)
        .where(TrainSettings.user_id == _USER_ID)
        .values(weekday_mask=three_bit_mask)
    )
    await db_session.flush()

    second = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )

    assert second.settled_streak_weeks == first.settled_streak_weeks
    assert second.flame_state == first.flame_state


# ---------------------------------------------------------------------------
# upsert_settings settle-before-mutate (Phase 191 Plan 02, Task 3, D-18)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_settings_update_settles_with_old_mask_first(db_session: AsyncSession) -> None:
    """D-18: three fully-elapsed weeks, each with exactly one completed
    session, are settled under the OLD weekday_mask=0 (1 session required
    each) BEFORE a new 3-bit mask (3 sessions required) is persisted — they
    must be judged fulfilled under the OLD standard, not missed under the
    NEW one."""
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)

    for week_monday in (
        datetime.date(2025, 12, 22),
        datetime.date(2025, 12, 29),
        datetime.date(2026, 1, 5),
    ):
        await _seed_completed_session(db_session, _USER_ID, week_monday)

    three_bit_mask = (1 << 0) | (1 << 2) | (1 << 4)
    updated = await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=three_bit_mask,
        puzzles_per_session=12,
        now_utc=_PROGRESS_NOW,
    )

    assert updated.streak_count == 3
    assert updated.weekday_mask == three_bit_mask

    row = (
        await db_session.execute(select(TrainSettings).where(TrainSettings.user_id == _USER_ID))
    ).scalar_one()
    assert row.weekday_mask == three_bit_mask
    assert row.streak_count == 3


@pytest.mark.asyncio
async def test_settings_update_timezone_only_change_still_settles(
    db_session: AsyncSession,
) -> None:
    """A timezone-only change still runs settlement (a timezone shift moves
    Mon-Sun week boundaries, D-18)."""
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)
    await _seed_completed_session(db_session, _USER_ID, _PROGRESS_PAST_WEEK_MONDAY)

    updated = await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="America/New_York",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_PROGRESS_NOW,
    )

    assert updated.streak_settled_through == _PROGRESS_PAST_WEEK_MONDAY
    assert updated.timezone == "America/New_York"

    row = (
        await db_session.execute(select(TrainSettings).where(TrainSettings.user_id == _USER_ID))
    ).scalar_one()
    assert row.timezone == "America/New_York"
    assert row.streak_settled_through == _PROGRESS_PAST_WEEK_MONDAY


@pytest.mark.asyncio
async def test_settings_update_no_elapsed_weeks_leaves_snapshot_unchanged(
    db_session: AsyncSession,
) -> None:
    """No elapsed unsettled weeks: upsert_settings leaves streak_count/
    flame_state/streak_settled_through unchanged and still persists the new
    values."""
    await ensure_test_user(db_session, _USER_ID)
    await train_repository.get_or_create_settings(db_session, user_id=_USER_ID)
    # No completed sessions at all -> nothing to settle.

    updated = await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0b0000101,
        puzzles_per_session=8,
        now_utc=_PROGRESS_NOW,
    )

    assert updated.streak_count == 0
    assert updated.flame_state is None
    assert updated.streak_settled_through is None
    assert updated.weekday_mask == 0b0000101
    assert updated.puzzles_per_session == 8


@pytest.mark.asyncio
async def test_settings_update_first_touch_creates_defaults_then_persists(
    db_session: AsyncSession,
) -> None:
    """upsert_settings on a user with no train_settings row creates the row
    with the D-06/D-07/D-08 defaults and an all-null snapshot, then persists
    the requested values, with no settlement error."""
    await ensure_test_user(db_session, _USER_ID)
    # No get_or_create_settings call beforehand — this IS the first touch.

    updated = await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="Europe/Zurich",
        weekday_mask=0b0010101,
        puzzles_per_session=6,
        now_utc=_PROGRESS_NOW,
    )

    assert updated.streak_count == 0
    assert updated.flame_state is None
    assert updated.streak_settled_through is None
    assert updated.timezone == "Europe/Zurich"
    assert updated.weekday_mask == 0b0010101
    assert updated.puzzles_per_session == 6

    row = (
        await db_session.execute(select(TrainSettings).where(TrainSettings.user_id == _USER_ID))
    ).scalar_one()
    assert row.timezone == "Europe/Zurich"


@pytest.mark.asyncio
async def test_settings_update_after_progress_read_does_not_resettle(
    db_session: AsyncSession,
) -> None:
    """A settlement already performed by a preceding GET /train/progress is
    not repeated: calling get_progress then upsert_settings in sequence
    leaves streak_count at the value the read produced."""
    await ensure_test_user(db_session, _USER_ID)
    await _seed_completed_session(db_session, _USER_ID, _PROGRESS_PAST_WEEK_MONDAY)

    progress = await train_repository.get_progress(
        db_session, user_id=_USER_ID, now_utc=_PROGRESS_NOW
    )
    assert progress.settled_streak_weeks == 1

    updated = await train_repository.upsert_settings(
        db_session,
        user_id=_USER_ID,
        timezone="UTC",
        weekday_mask=0,
        puzzles_per_session=12,
        now_utc=_PROGRESS_NOW,
    )

    assert updated.streak_count == 1


# ---------------------------------------------------------------------------
# record_solve — tiered move_quality (SEED-119)
# ---------------------------------------------------------------------------


async def _seed_open_session_with_sr_item(
    db_session: AsyncSession, user_id: int, label: str, *, streak: int = 0
) -> DrillSession:
    """Seed one ACTIVE drill_items row + one open session with a single
    unsolved SR-source drill_solves row at position 0, ready for record_solve."""
    game_id = await _seed_flaw_game(db_session, user_id, label)
    db_session.add(
        DrillItem(
            user_id=user_id,
            game_id=game_id,
            ply=2,
            status=DrillStatus.ACTIVE,
            streak=streak,
            due_date=_TODAY,
            fail_count=0,
            ever_correct=(streak > 0),
        )
    )
    drill_session = DrillSession(
        user_id=user_id,
        session_date=_TODAY,
        status="open",
        puzzle_count=1,
        expires_on=_TODAY + datetime.timedelta(days=1),
    )
    db_session.add(drill_session)
    await db_session.flush()
    db_session.add(
        DrillSolve(
            session_id=drill_session.id,
            position=0,
            user_id=user_id,
            game_id=game_id,
            ply=2,
            source=DrillSource.SR_ITEM,
            solved_at=None,
        )
    )
    await db_session.flush()
    return drill_session


@pytest.mark.asyncio
async def test_record_solve_persists_move_quality_alongside_correct_move(
    db_session: AsyncSession,
) -> None:
    """SEED-119: record_solve persists the DrillMoveQuality int and the
    derived correct_move boolean side by side."""
    await ensure_test_user(db_session, _USER_ID)
    drill_session = await _seed_open_session_with_sr_item(db_session, _USER_ID, "mq-persist")

    recorded = await train_repository.record_solve(
        db_session,
        user_id=_USER_ID,
        session_id=drill_session.id,
        position=0,
        guess="critical",
        played_move="e2e4",
        move_quality="inaccuracy",
        now_utc=_NOW,
    )
    assert recorded is not None
    assert recorded.move_quality == "inaccuracy"
    assert recorded.correct_move is True  # inaccuracy still passes the ladder

    row = (
        await db_session.execute(
            select(DrillSolve).where(
                DrillSolve.session_id == drill_session.id, DrillSolve.position == 0
            )
        )
    ).scalar_one()
    assert row.move_quality == int(DrillMoveQuality.INACCURACY)
    assert row.correct_move is True


@pytest.mark.asyncio
async def test_record_solve_inaccuracy_advances_ladder_exactly_like_good(
    db_session: AsyncSession,
) -> None:
    """SEED-119 regression guard: an inaccuracy must advance drill_items'
    SR state (status/streak/due_date) identically to a good move — this is
    the invariant the whole tiering change must not break."""
    await ensure_test_user(db_session, _USER_ID)
    await ensure_test_user(db_session, _OTHER_USER_ID)

    good_session = await _seed_open_session_with_sr_item(db_session, _USER_ID, "mq-good", streak=1)
    inaccuracy_session = await _seed_open_session_with_sr_item(
        db_session, _OTHER_USER_ID, "mq-inaccuracy", streak=1
    )

    good_result = await train_repository.record_solve(
        db_session,
        user_id=_USER_ID,
        session_id=good_session.id,
        position=0,
        guess="critical",
        played_move="e2e4",
        move_quality="good",
        now_utc=_NOW,
    )
    inaccuracy_result = await train_repository.record_solve(
        db_session,
        user_id=_OTHER_USER_ID,
        session_id=inaccuracy_session.id,
        position=0,
        guess="critical",
        played_move="e2e4",
        move_quality="inaccuracy",
        now_utc=_NOW,
    )

    assert good_result is not None
    assert inaccuracy_result is not None
    assert inaccuracy_result.item_status == good_result.item_status
    assert inaccuracy_result.streak == good_result.streak
    assert inaccuracy_result.due_date == good_result.due_date


@pytest.mark.asyncio
async def test_record_solve_resubmit_returns_first_recorded_tier(
    db_session: AsyncSession,
) -> None:
    """A re-submit with a DIFFERENT move_quality returns the FIRST recorded
    tier, never the second call's (mirrors the pre-existing
    correct_guess/correct_move idempotence contract)."""
    await ensure_test_user(db_session, _USER_ID)
    drill_session = await _seed_open_session_with_sr_item(db_session, _USER_ID, "mq-resubmit")

    first = await train_repository.record_solve(
        db_session,
        user_id=_USER_ID,
        session_id=drill_session.id,
        position=0,
        guess="critical",
        played_move="e2e4",
        move_quality="good",
        now_utc=_NOW,
    )
    second = await train_repository.record_solve(
        db_session,
        user_id=_USER_ID,
        session_id=drill_session.id,
        position=0,
        guess="several",
        played_move="d2d4",
        move_quality="wrong",
        now_utc=_NOW,
    )

    assert first is not None
    assert second is not None
    assert first.move_quality == "good"
    assert second.move_quality == "good"  # first recorded tier wins, not "wrong"
    assert second.correct_move == first.correct_move


@pytest.mark.asyncio
async def test_out_of_range_move_quality_violates_check_constraint(
    db_session: AsyncSession,
) -> None:
    """The ck_drill_solves_move_quality CHECK constraint rejects a direct
    UPDATE writing an out-of-range value (3) — proving the constraint
    actually reached the migrated schema, not just the ORM-level enum."""
    await ensure_test_user(db_session, _USER_ID)
    drill_session = await _seed_open_session_with_sr_item(db_session, _USER_ID, "mq-outofrange")

    with pytest.raises(IntegrityError):
        await db_session.execute(
            update(DrillSolve)
            .where(DrillSolve.session_id == drill_session.id, DrillSolve.position == 0)
            .values(move_quality=3)
        )
        await db_session.flush()
