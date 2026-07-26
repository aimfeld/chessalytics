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

Data isolation: uses the rollback-scoped ``db_session`` fixture from
tests/conftest.py, following tests/repositories/test_bot_game_settings_repository.py's
precedent — no committed rows leak between tests.
"""

from __future__ import annotations

import datetime
import uuid

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.drill_item import DrillItem, DrillStatus
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.repositories import train_repository
from app.services.train_pool import compose_slots
from tests.conftest import ensure_test_user

# Unique user ID for this test module (distinct from other repo test modules —
# see test_bot_game_settings_repository.py's 92400 / test_game_repository_persona_wins.py's
# 92401/92402). Every test in this file uses the same rollback-scoped db_session fixture,
# so reuse across test functions within the file is safe.
_USER_ID = 93100

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
    """Plenty of material on both sides -> exactly the 9/3 default split."""
    await ensure_test_user(db_session, _USER_ID)
    for i in range(12):
        await _seed_flaw_game(db_session, _USER_ID, f"full-sr-{i}")
    for i in range(5):
        await _seed_herring_game(db_session, _USER_ID, f"full-herring-{i}")

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
    """Too few SR items -> herrings fill the gap up to N."""
    await ensure_test_user(db_session, _USER_ID)
    for i in range(2):
        await _seed_flaw_game(db_session, _USER_ID, f"short-sr-{i}")
    for i in range(15):
        await _seed_herring_game(db_session, _USER_ID, f"short-herring-{i}")

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
    """Too few herrings -> SR items fill the gap up to N."""
    await ensure_test_user(db_session, _USER_ID)
    for i in range(15):
        await _seed_flaw_game(db_session, _USER_ID, f"hshort-sr-{i}")
    await _seed_herring_game(db_session, _USER_ID, "hshort-herring-0")

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
async def test_padding_introduces_new_drill_items_recency_first(db_session: AsyncSession) -> None:
    """The newly-tracked drill_items correspond to the most recently played games."""
    await ensure_test_user(db_session, _USER_ID)
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
        await _seed_herring_game(db_session, _USER_ID, f"recency-herring-{i}")

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
        await _seed_herring_game(db_session, _USER_ID, f"frozen-herring-{i}")

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
