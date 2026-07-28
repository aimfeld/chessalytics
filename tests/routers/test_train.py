"""Integration tests for the Train router (Phase 189, Plans 01 + 04 + 05).

Coverage:
- test_compose_session_serves_own_blunder : a qualifying own blunder is served as
                                             one puzzle, 200, full 6-field FEN
- test_opponent_flaw_excluded             : an opponent-side flaw never enters the pool
- test_null_blob_excluded                 : a blunder with no missed_pv_lines blob is excluded
- test_empty_blob_excluded                : 189-06 gap closure — a non-NULL EMPTY
                                             missed_pv_lines (`[]`, the D-06 un-fillable
                                             sentinel) is excluded, same as a NULL blob
- test_below_winnability_floor_excluded   : a hopeless pre-flaw position is excluded
- test_403_guest                          : a guest account is rejected before any pool query
- test_401_unauthenticated                : no auth token returns 401
- test_pre_attempt_payload_shape          : the puzzle dict's key set is exactly the POOL-10 six
- test_drill_items_fk_targets             : drill_items' FK referenced-table set is {users, games}
- test_compose_twice_returns_same_session_id      : D-12 resume over real HTTP
- test_concurrent_compose_yields_one_open_session : uq_drill_sessions_user_open holds
                                             under two simultaneous requests (T-189-14)

Dev clock override (app/core/dev_clock.py) — unit coverage in tests/test_dev_clock.py:
- test_dev_clock_header_shifts_composition_in_development : the shifted instant reaches
                                             composition's expiry/session_date logic
- test_dev_clock_header_ignored_outside_development : the fail-closed gate — a forged
                                             header cannot shift a real deployment's calendar

Plan 02 (190-02, SOLV-02/SOLV-05 payload additions):
- test_last_move_uci_matches_pgn_at_ply_minus_one : last_move_uci is the game's own
                                             PGN half-move at ply-1
- test_ply_zero_puzzle_serialises_last_move_uci_as_null : ply=0 -> null, not "" or a
                                             fabricated move

190.1-03 (Task 3, D-01/D-05 — best_move/best_move_san/pv retired from the reveal):
- test_reveal_key_set_excludes_stored_answer_key_fields : the exact response key
                                             set is the standing assertion that no
                                             stored engine line/eval creeps back in

Plan 05 (POOL-08/POOL-10, solve/reveal/settings):
- test_solve_records_and_advances_streak / test_solve_masters_item_at_three /
  test_solve_wrong_resets_streak_and_counts_fail / test_solve_parks_item_at_three_never_correct :
      the interval ladder advances exactly per app.services.train_scheduler.apply_result
- test_solve_herring_touches_no_drill_item : a red herring carries no SR bookkeeping
- test_correct_guess_computed_server_side  : the guess verdict is server-computed, never
                                              client-asserted (parametrized 2 guesses x 2 types)
- test_solve_is_idempotent_per_position / test_concurrent_solve_advances_streak_once :
      the claiming UPDATE's solved_at IS NULL guard is the whole concurrency story (T-189-19)
- test_solve_foreign_session_404 / test_solve_unknown_position_404 : IDOR guard (T-189-16)
- test_last_solve_completes_session : session_complete flips once every puzzle is recorded
- test_reveal_409_before_attempt / test_reveal_200_after_attempt /
  test_reveal_herring_reports_herring_type / test_reveal_foreign_session_404 /
  test_reveal_unknown_position_404 / test_reveal_has_tactic_lines_flag :
      the reveal gate (T-189-17) and its POOL-02/tactic-lines-pointer fields
- test_get_settings_creates_defaults_on_first_touch / test_get_settings_is_idempotent /
  test_put_settings_persists_and_round_trips / test_put_settings_rejects_bad_timezone_422 /
  test_put_settings_rejects_out_of_range_mask_422 / test_settings_403_guest /
  test_session_size_follows_settings : the D-06/D-07/D-08 settings surface

Phase 191 Plan 01 (PROG-01/PROG-04, D-18) — GET /train/progress:
- test_progress_returns_200_with_all_seven_fields : an authenticated non-guest
                                                     account gets a full payload
- test_progress_403_guest                         : the D-05 guest gate applies here too
"""

from __future__ import annotations

import asyncio
import datetime
import uuid

import httpx
import pytest
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import settings as config_settings
from app.core.dev_clock import DEV_CLOCK_OFFSET_HEADER
from app.main import app
from app.models.drill_item import DrillItem, DrillStatus
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.models.herring_pool import HerringPool
from app.schemas.train import SolveRequest

ENDPOINT = "/api/train/sessions"

# POOL-02 puzzle-type fixtures: a "sharp" blob has a wide best-vs-second gap
# (>= SHARP_GAP_ES == MISTAKE_DROP == 0.10); the module's default
# _MISSED_PV_LINES blob (b=40, s=-30 -> gap ~0.064) is deliberately "soft".
_SHARP_PV_LINES = [{"b": 200, "bm": None, "s": -200, "sm": None, "su": "g8f6"}]

# A real, legal Ruy Lopez opening PGN — long enough (10 half-moves) to replay
# any flaw ply this file exercises via chess.pgn.
_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 *"

# ply=6 (even -> white mover): position before white's 4th move (Ba4).
_FLAW_PLY_WHITE = 6
# ply=7 (odd -> black mover): position before black's 4th move (Nf6).
_FLAW_PLY_BLACK = 7

_MISSED_PV_LINES = [{"b": 40, "bm": None, "s": -30, "sm": None, "su": "g8f6"}]

# A comfortably winnable eval for White (well above WINNABILITY_FLOOR_ES=0.20).
_WINNABLE_CP = 300
# A hopeless eval for White (well below the floor).
_HOPELESS_CP = -2000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _register_and_login(email: str, password: str = "testpass123!") -> tuple[int, str]:
    """Register a user via HTTP and return (user_id, auth_token)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        reg = await client.post("/api/auth/register", json={"email": email, "password": password})
        assert reg.status_code in (200, 201), f"register failed: {reg.text}"
        user_id = int(reg.json()["id"])

        login = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": password},
        )
        assert login.status_code == 200, f"login failed: {login.text}"
        token = str(login.json()["access_token"])
    return user_id, token


async def _seed_game_with_blunder(
    test_engine,
    user_id: int,
    *,
    ply: int = _FLAW_PLY_WHITE,
    user_color: str = "white",
    missed_pv_lines: list | None = _MISSED_PV_LINES,
    prior_eval_cp: int | None = _WINNABLE_CP,
    seed_prior_position: bool = True,
    missed_tactic_motif: int | None = None,
    allowed_tactic_motif: int | None = None,
) -> int:
    """Seed one game + one blunder flaw row (+ optional prior-ply eval). Returns game_id.

    `missed_pv_lines` defaults to a non-empty blob (the qualifying case);
    pass `missed_pv_lines=None` explicitly to test the no-answer-key
    exclusion path — `None` is a real, distinct value here, not a "use the
    default" sentinel (the module-level `_MISSED_PV_LINES` constant is never
    mutated, so reusing it as a default parameter value is safe).
    """
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            game = Game(
                user_id=user_id,
                platform="lichess",
                platform_game_id=str(uuid.uuid4()),
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
                ply_count=10,
                full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
            )
            session.add(game)
            await session.flush()
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
                # JSONB gotcha (project_asyncpg_jsonb_null_vs_sql_null): passing
                # missed_pv_lines=None explicitly would write null::jsonb, which
                # `IS NOT NULL` treats as present — OMIT the column entirely to
                # get a true SQL NULL (the "no blob" state pool_entry_stmt tests
                # for via GameFlaw.missed_pv_lines.isnot(None)).
                flaw_kwargs["missed_pv_lines"] = missed_pv_lines
            if missed_tactic_motif is not None:
                flaw_kwargs["missed_tactic_motif"] = missed_tactic_motif
            if allowed_tactic_motif is not None:
                flaw_kwargs["allowed_tactic_motif"] = allowed_tactic_motif
            flaw = GameFlaw(**flaw_kwargs)
            session.add(flaw)

            if seed_prior_position and prior_eval_cp is not None:
                prior = GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=ply - 1,
                    full_hash=1000 + game_id,
                    white_hash=2000 + game_id,
                    black_hash=3000 + game_id,
                    eval_cp=prior_eval_cp,
                    eval_mate=None,
                )
                session.add(prior)

    return game_id


async def _seed_game_with_pgn(test_engine, user_id: int, pgn: str, label: str) -> int:
    """Seed a bare Game row with a CUSTOM PGN (190.1-01 promotion-UCI test —
    the default `_PGN` fixture never reaches a promotable position)."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            game = Game(
                user_id=user_id,
                platform="lichess",
                platform_game_id=f"{label}-{uuid.uuid4().hex[:8]}",
                platform_url="https://lichess.org/test",
                pgn=pgn,
                result="1-0",
                user_color="white",
                time_control_str="600+0",
                time_control_bucket="blitz",
                time_control_seconds=600,
                base_time_seconds=600,
                increment_seconds=0.0,
                rated=True,
                is_computer_game=False,
                ply_count=10,
                full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
            )
            session.add(game)
            await session.flush()
            return game.id


async def _delete_games(test_engine, game_ids: list[int]) -> None:
    if not game_ids:
        return
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            await session.execute(delete(Game).where(Game.id.in_(game_ids)))


async def _set_guest(test_engine, user_id: int) -> None:
    from app.models.user import User

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            await session.execute(update(User).where(User.id == user_id).values(is_guest=True))


# ---------------------------------------------------------------------------
# Plan 05 helpers — direct seeding of drill_items/drill_sessions/drill_solves
# gives each test full control over the pre-solve SR state (streak/fail_count/
# ever_correct) without needing to control the endpoint's real wall-clock
# `now_utc` across multiple composed sessions.
# ---------------------------------------------------------------------------


async def _seed_bare_game(test_engine, user_id: int, label: str) -> int:
    """Seed a Game row with no flaw/best-move rows attached. Returns game_id."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
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
                ply_count=10,
                full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
            )
            session.add(game)
            await session.flush()
            return game.id


# A default 5-entry MultiPV-5 ladder (white POV, best-first) for herring_pool
# row fixtures that don't care about the exact ladder shape (mirrors
# tests/repositories/test_train_repository.py's _DEFAULT_LADDER).
_DEFAULT_HERRING_LADDER: list[dict[str, object]] = [
    {"move_uci": "e2e4", "cp": 30, "mate": None},
    {"move_uci": "d2d4", "cp": 26, "mate": None},
    {"move_uci": "g1f3", "cp": 20, "mate": None},
    {"move_uci": "c2c4", "cp": 15, "mate": None},
    {"move_uci": "b1c3", "cp": 10, "mate": None},
]


async def _seed_herring_pool_row(
    test_engine,
    user_id: int,
    game_id: int,
    ply: int,
    *,
    mover_color: str = "white",
    fen: str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    arriving_move_uci: str | None = "e2e4",
) -> int:
    """Seed one `herring_pool` row attached to `game_id` (Phase 192, sibling
    to tests/repositories/test_train_repository.py's `_seed_herring_pool_row`,
    duplicated here for this file's `test_engine`-based seeding style rather
    than the repository suite's rollback-scoped `db_session` fixture).
    Returns the pool row's id.
    """
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            row = HerringPool(
                user_id=user_id,
                game_id=game_id,
                ply=ply,
                mover_color=mover_color,
                fen=fen,
                arriving_move_uci=arriving_move_uci,
                phase=1,
                ladder=_DEFAULT_HERRING_LADDER,
            )
            session.add(row)
            await session.flush()
            return row.id


async def _delete_herring_pool_rows(test_engine, herring_pool_ids: list[int]) -> None:
    """Explicit cleanup for herring_pool test rows (mirrors
    tests/services/test_train_pool.py's identically-named helper).

    `_delete_games`'s FK is `ondelete="SET NULL"` (D-01), NOT `CASCADE` —
    deleting the backing game nulls out the pool row's `user_id`/`game_id`
    but does not remove it. `herring_stmt`/`get_waiting_puzzle_count` are
    deliberately identity-blind (D-10, no `HerringPool.user_id` filter), so
    an orphaned row from an earlier test leaks into every later test's
    results in this shared per-run DB. Must be called BEFORE `_delete_games`
    in a test's `finally` block.
    """
    if not herring_pool_ids:
        return
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            await session.execute(delete(HerringPool).where(HerringPool.id.in_(herring_pool_ids)))


async def _seed_drill_item(
    test_engine,
    user_id: int,
    game_id: int,
    ply: int,
    *,
    status: int = DrillStatus.ACTIVE,
    streak: int = 0,
    fail_count: int = 0,
    ever_correct: bool = False,
) -> None:
    """Seed one drill_items row with an explicit pre-solve SR state."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            session.add(
                DrillItem(
                    user_id=user_id,
                    game_id=game_id,
                    ply=ply,
                    status=int(status),
                    streak=streak,
                    due_date=datetime.datetime.now(datetime.timezone.utc).date(),
                    fail_count=fail_count,
                    ever_correct=ever_correct,
                )
            )


async def _seed_session(
    test_engine,
    user_id: int,
    entries: list[tuple[int, int, int]],
    *,
    requested_count: int | None = None,
    herring_pool_ids: dict[int, int] | None = None,
) -> int:
    """Seed one open drill_sessions row plus one unsolved drill_solves row per entry.

    `entries` is a list of `(game_id, ply, source)` tuples, one per frozen
    position (0-based, in list order) — mirrors exactly what
    `compose_and_materialize_session` would have pre-inserted.

    `requested_count` defaults to `None` (the "pre-migration row / direct
    test fixture" shape — see `DrillSession.requested_count`'s docstring),
    matching every pre-existing caller of this helper, which never seeded a
    session that should be eligible for `_discard_if_untouched_and_resized`'s
    resize check. Pass it explicitly to simulate a session that a real
    composition call would have produced under a specific
    `puzzles_per_session`.

    `herring_pool_ids` (Phase 192) maps a 0-based `position` to the
    `herring_pool.id` that entry's `RED_HERRING` row should carry — omitted
    entirely (default `None`) for every pre-Phase-192 caller of this helper,
    which never needed a real pool link.
    """
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    today = datetime.datetime.now(datetime.timezone.utc).date()
    async with session_maker() as session:
        async with session.begin():
            drill_session = DrillSession(
                user_id=user_id,
                session_date=today,
                status="open",
                puzzle_count=len(entries),
                requested_count=requested_count,
                expires_on=today + datetime.timedelta(days=7),
            )
            session.add(drill_session)
            await session.flush()
            for position, (game_id, ply, source) in enumerate(entries):
                herring_pool_id = herring_pool_ids.get(position) if herring_pool_ids else None
                session.add(
                    DrillSolve(
                        session_id=drill_session.id,
                        position=position,
                        user_id=user_id,
                        game_id=game_id,
                        ply=ply,
                        source=source,
                        herring_pool_id=herring_pool_id,
                        solved_at=None,
                    )
                )
            session_id = drill_session.id
    return session_id


async def _seed_position_meta(
    test_engine,
    user_id: int,
    game_id: int,
    ply: int,
    *,
    best_move: str,
    move_san: str,
    pv: str | None = None,
) -> None:
    """Seed a game_positions row carrying `best_move`/`move_san`/`pv`.

    190.1-03: the reveal endpoint itself only reads `move_san` now (the
    in-game move) — `best_move`/`pv` are written here purely because they are
    real, non-nullable-adjacent `game_positions` columns other features
    (gem/great detection, tactic lines) still depend on; `pv` defaults to
    None since no reveal test needs a stored line anymore.
    """
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            session.add(
                GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=ply,
                    full_hash=7_000_000 + game_id * 100 + ply,
                    white_hash=8_000_000 + game_id * 100 + ply,
                    black_hash=9_000_000 + game_id * 100 + ply,
                    best_move=best_move,
                    move_san=move_san,
                    pv=pv,
                )
            )


async def _get_drill_item(test_engine, user_id: int, game_id: int, ply: int) -> DrillItem | None:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        result = await session.execute(
            select(DrillItem).where(
                DrillItem.user_id == user_id, DrillItem.game_id == game_id, DrillItem.ply == ply
            )
        )
        return result.scalar_one_or_none()


async def _count_drill_items(test_engine, user_id: int) -> int:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        result = await session.execute(
            select(func.count()).select_from(DrillItem).where(DrillItem.user_id == user_id)
        )
        return result.scalar_one()


async def _get_session_status(test_engine, session_id: int) -> str:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        result = await session.execute(
            select(DrillSession.status).where(DrillSession.id == session_id)
        )
        return result.scalar_one()


async def _solve(
    token: str,
    session_id: int,
    position: int,
    *,
    guess: str = "several",
    played_move: str = "e2e4",
    move_quality: str = "good",
) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.post(
            f"/api/train/sessions/{session_id}/solve",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "position": position,
                "guess": guess,
                "played_move": played_move,
                "move_quality": move_quality,
            },
        )


async def _reveal(token: str, session_id: int, position: int) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get(
            f"/api/train/sessions/{session_id}/puzzles/{position}/reveal",
            headers={"Authorization": f"Bearer {token}"},
        )


async def _get_settings(token: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get("/api/train/settings", headers={"Authorization": f"Bearer {token}"})


async def _get_progress(token: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get("/api/train/progress", headers={"Authorization": f"Bearer {token}"})


async def _seed_completed_session_router(
    test_engine, user_id: int, session_date: datetime.date
) -> None:
    """Seed a bare status='completed' drill_sessions row via test_engine
    (mirrors the repository test suite's _seed_completed_session, but for
    the router test file's HTTP-registered users)."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            session.add(
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


async def _seed_pool_eligible_since_router(test_engine, user_id: int, since: datetime.date) -> None:
    """Directly stamp the D-06 eligibility watermark via test_engine
    (mirrors the repository test suite's `_seed_pool_eligible_since`, for
    the router test file's HTTP-registered users). Creates a default
    train_settings row first if one does not already exist, mirroring
    `train_repository.get_or_create_settings`'s own insert shape."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.train_settings import TrainSettings
    from app.services.train_scheduler import (
        DEFAULT_PUZZLES_PER_SESSION,
        DEFAULT_TIMEZONE,
        DEFAULT_WEEKDAY_MASK,
    )

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            stmt = pg_insert(TrainSettings).values(
                user_id=user_id,
                timezone=DEFAULT_TIMEZONE,
                weekday_mask=DEFAULT_WEEKDAY_MASK,
                puzzles_per_session=DEFAULT_PUZZLES_PER_SESSION,
                streak_count=0,
                shield_level=0,
                streak_settled_through=None,
                pool_eligible_since=since,
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=["user_id"], set_={"pool_eligible_since": since}
            )
            await session.execute(stmt)


async def _put_settings(
    token: str, *, timezone: str, weekday_mask: int, puzzles_per_session: int
) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.put(
            "/api/train/settings",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "timezone": timezone,
                "weekday_mask": weekday_mask,
                "puzzles_per_session": puzzles_per_session,
            },
        )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compose_session_serves_own_blunder(test_engine) -> None:
    """A qualifying own blunder is served as one puzzle over real HTTP."""
    email = f"train-own-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body["puzzle_count"] == 1
        assert len(body["puzzles"]) == 1
        puzzle = body["puzzles"][0]
        assert puzzle["game_id"] == game_id
        assert puzzle["ply"] == _FLAW_PLY_WHITE
        assert puzzle["side_to_move"] == "white"
        fen_fields = puzzle["fen"].split(" ")
        assert len(fen_fields) == 6, f"Expected a full 6-field FEN, got: {puzzle['fen']!r}"
        assert body["session_id"] is not None
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_opponent_flaw_excluded(test_engine) -> None:
    """A flaw whose mover is the opponent (ply parity) never enters the pool."""
    email = f"train-opp-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    # user_color=white, ply=7 (odd) -> black mover -> opponent flaw, excluded.
    game_id = await _seed_game_with_blunder(
        test_engine, user_id, ply=_FLAW_PLY_BLACK, user_color="white"
    )

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_count"] == 0
        assert body["puzzles"] == []
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_null_blob_excluded(test_engine) -> None:
    """A blunder with no missed_pv_lines blob (no answer key) is excluded."""
    email = f"train-noblob-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, missed_pv_lines=None)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_count"] == 0
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_empty_blob_excluded(test_engine) -> None:
    """189-06 gap closure: a blunder with a non-NULL EMPTY missed_pv_lines
    (`[]`, the eval pipeline's D-06 un-fillable sentinel) is excluded from the
    served pool exactly like test_null_blob_excluded's true-NULL case."""
    email = f"train-emptyblob-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, missed_pv_lines=[])

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_count"] == 0
        assert body["blob_pending_count"] == 0
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_below_winnability_floor_excluded(test_engine) -> None:
    """A blunder from an already-hopeless pre-move position is excluded."""
    email = f"train-hopeless-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, prior_eval_cp=_HOPELESS_CP)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_count"] == 0
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_403_guest(test_engine) -> None:
    """A guest account is rejected 403 before any pool query runs (D-05)."""
    email = f"train-guest-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    await _set_guest(test_engine, user_id)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Train requires a full account"


@pytest.mark.asyncio
async def test_401_unauthenticated() -> None:
    """No auth token returns 401."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(ENDPOINT)

    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_pre_attempt_payload_shape(test_engine) -> None:
    """The puzzle dict's key set is EXACTLY the POOL-10 six fields (P-01, 190-02).

    Equality, not membership (`set(...) == {...}`, never `in`/`assertIn`): a
    future answer-key field addition (best_move, pv, puzzle_type, source)
    must fail this test, not silently pass it.
    """
    email = f"train-shape-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_count"] == 1
        puzzle = body["puzzles"][0]
        assert set(puzzle.keys()) == {
            "position",
            "game_id",
            "ply",
            "fen",
            "side_to_move",
            "last_move_uci",
        }
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_last_move_uci_matches_pgn_at_ply_minus_one(test_engine) -> None:
    """last_move_uci (190-02, SOLV-02) is the game's own PGN half-move at ply-1."""
    email = f"train-lastmove-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    # _FLAW_PLY_WHITE == 6; _PGN's half-move at index 5 (0-based) is "a6" (a7a6).
    game_id = await _seed_game_with_blunder(test_engine, user_id, ply=_FLAW_PLY_WHITE)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        puzzle = resp.json()["puzzles"][0]
        assert puzzle["last_move_uci"] == "a7a6"
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_ply_zero_puzzle_serialises_last_move_uci_as_null(test_engine) -> None:
    """A ply=0 puzzle (no prior move) carries last_move_uci: null, not "" or a fabricated move.

    pool_entry_stmt's winnability floor reads the PRE-flaw-move eval at
    ply-1, which cannot exist for ply=0 (no row -1) — a ply-0 blunder can
    never qualify through fresh composition. The resume path
    (load_session_puzzles) has no such floor, so a directly-seeded session
    entry at ply=0 exercises the same fen_and_last_move_at_ply(pgn, 0) call
    the composition path uses.

    Phase 192 (D-03): a red herring's resume FEN/last-move now come
    EXCLUSIVELY off its `herring_pool` row, never `fen_and_last_move_at_ply`
    — so this uses an SR item (the source this call still applies to) rather
    than the RED_HERRING source the pre-Phase-192 version of this test used.
    """
    email = f"train-ply0-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, ply=0, seed_prior_position=False)
    await _seed_session(test_engine, user_id, [(game_id, 0, int(DrillSource.SR_ITEM))])

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_count"] == 1
        puzzle = body["puzzles"][0]
        assert puzzle["ply"] == 0
        assert puzzle["last_move_uci"] is None
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_drill_items_fk_targets(test_engine) -> None:
    """drill_items' FK referenced-table set is exactly {users, games} (D-02 proof)."""
    async with test_engine.connect() as conn:
        result = await conn.execute(
            text(
                """
                SELECT DISTINCT ccu.table_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.constraint_column_usage ccu
                  ON tc.constraint_name = ccu.constraint_name
                 AND tc.constraint_schema = ccu.constraint_schema
                WHERE tc.table_name = 'drill_items'
                  AND tc.constraint_type = 'FOREIGN KEY'
                """
            )
        )
        referenced_tables = {row[0] for row in result.all()}

    assert referenced_tables == {"users", "games"}


@pytest.mark.asyncio
async def test_compose_twice_returns_same_session_id(test_engine) -> None:
    """D-12: a second POST inside an open session's window resumes it (real HTTP)."""
    email = f"train-resume-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            first = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})
            second = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})

        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["session_id"] is not None
        assert first.json()["session_id"] == second.json()["session_id"]
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_dev_clock_header_shifts_composition_in_development(test_engine, monkeypatch) -> None:
    """The dev clock header moves the Train calendar forward end-to-end.

    Guards the wiring, not just `dev_now_utc` in isolation: a session composed
    "today" must be replaced by a NEW one dated a week later once the request
    carries `X-Dev-Clock-Offset-Minutes`, proving the shifted instant reaches
    `compose_and_materialize_session`'s expiry/`session_date` logic rather than
    being dropped somewhere in the router.
    """
    monkeypatch.setattr(config_settings, "ENVIRONMENT", "development")
    email = f"train-devclock-dev-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    auth = {"Authorization": f"Bearer {token}"}

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            today_resp = await client.post(ENDPOINT, headers=auth)
            shifted_resp = await client.post(
                ENDPOINT,
                headers={**auth, DEV_CLOCK_OFFSET_HEADER: str(7 * 24 * 60)},
            )

        assert today_resp.status_code == 200
        assert shifted_resp.status_code == 200
        today_date = datetime.date.fromisoformat(today_resp.json()["session_date"])
        shifted_date = datetime.date.fromisoformat(shifted_resp.json()["session_date"])
        assert shifted_date - today_date == datetime.timedelta(days=7)
        assert shifted_resp.json()["session_id"] != today_resp.json()["session_id"]
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_dev_clock_header_ignored_outside_development(test_engine, monkeypatch) -> None:
    """A forged offset header cannot shift the calendar in a real deployment.

    The fail-closed gate matters here specifically: an honoured header would
    let a client fabricate streak weeks and due-date advances at will. With
    ENVIRONMENT != "development" the second POST must simply resume the same
    open session (D-12), exactly as an unshifted request would.
    """
    monkeypatch.setattr(config_settings, "ENVIRONMENT", "production")
    email = f"train-devclock-prod-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    auth = {"Authorization": f"Bearer {token}"}

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            first = await client.post(ENDPOINT, headers=auth)
            forged = await client.post(
                ENDPOINT,
                headers={**auth, DEV_CLOCK_OFFSET_HEADER: str(7 * 24 * 60)},
            )

        assert first.status_code == 200
        assert forged.status_code == 200
        assert forged.json()["session_id"] == first.json()["session_id"]
        assert forged.json()["session_date"] == first.json()["session_date"]
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_concurrent_compose_yields_one_open_session(test_engine) -> None:
    """T-189-14: two simultaneous POSTs leave exactly one open drill_sessions row.

    Two independent httpx.AsyncClient instances (each request gets its own DB
    session via the FastAPI dependency) — NOT the forbidden shared-AsyncSession
    pattern.
    """
    email = f"train-concurrent-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)

    try:
        async with (
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client_a,
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client_b,
        ):
            resp_a, resp_b = await asyncio.gather(
                client_a.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"}),
                client_b.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"}),
            )

        assert resp_a.status_code == 200
        assert resp_b.status_code == 200
        assert resp_a.json()["session_id"] is not None
        assert resp_a.json()["session_id"] == resp_b.json()["session_id"]

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            open_count = (
                await session.execute(
                    select(func.count())
                    .select_from(DrillSession)
                    .where(DrillSession.user_id == user_id, DrillSession.status == "open")
                )
            ).scalar_one()
        assert open_count == 1
    finally:
        await _delete_games(test_engine, [game_id])


# ---------------------------------------------------------------------------
# Plan 05 Task 1 — POST /sessions/{session_id}/solve
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_solve_records_and_advances_streak(test_engine) -> None:
    """A correct solve advances streak 0 -> 1, stays active, gets a real due_date."""
    email = f"train-solve-adv-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, missed_pv_lines=_SHARP_PV_LINES)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=0)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 0, guess="critical", move_quality="good")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["item_status"] == "active"
        assert body["streak"] == 1
        assert body["due_date"] is not None
        assert body["correct_move"] is True

        item = await _get_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
        assert item is not None
        assert item.streak == 1
        assert item.status == DrillStatus.ACTIVE
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "move_quality,expected_correct_move",
    [
        ("good", True),
        ("inaccuracy", True),
        ("wrong", False),
    ],
)
async def test_solve_move_quality_round_trips_with_derived_correct_move(
    test_engine, move_quality: str, expected_correct_move: bool
) -> None:
    """SEED-119: each of the three tiers round-trips in the response, with
    correct_move derived as move_quality != "wrong" (good/inaccuracy both
    pass the SR ladder, only wrong fails it)."""
    email = f"train-tier-{move_quality}-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=0)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 0, move_quality=move_quality)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["move_quality"] == move_quality
        assert body["correct_move"] is expected_correct_move
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_rejects_unrecognised_move_quality(test_engine) -> None:
    """An unrecognised move_quality string is rejected 422 (Pydantic Literal)."""
    email = f"train-tier-bad-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=0)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 0, move_quality="excellent")
        assert resp.status_code == 422
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_masters_item_at_three(test_engine) -> None:
    """The third consecutive correct solve masters the item (POOL-05)."""
    email = f"train-master-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(
        test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=2, ever_correct=True
    )
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 0, move_quality="good")
        assert resp.status_code == 200
        body = resp.json()
        assert body["item_status"] == "mastered"
        assert body["streak"] == 3

        item = await _get_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
        assert item is not None
        assert item.status == DrillStatus.MASTERED
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_wrong_resets_streak_and_counts_fail(test_engine) -> None:
    """A wrong solve resets streak to 0 and counts a fail while ever_correct is False."""
    email = f"train-wrong-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(
        test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=0, fail_count=1, ever_correct=False
    )
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 0, move_quality="wrong")
        assert resp.status_code == 200
        body = resp.json()
        assert body["item_status"] == "active"
        assert body["streak"] == 0
        assert body["correct_move"] is False

        item = await _get_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
        assert item is not None
        assert item.streak == 0
        assert item.fail_count == 2
        assert item.ever_correct is False
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_parks_item_at_three_never_correct(test_engine) -> None:
    """The third never-correct failure parks the item (POOL-06)."""
    email = f"train-park-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(
        test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=0, fail_count=2, ever_correct=False
    )
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 0, move_quality="wrong")
        assert resp.status_code == 200
        body = resp.json()
        assert body["item_status"] == "parked"

        item = await _get_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
        assert item is not None
        assert item.status == DrillStatus.PARKED
        assert item.fail_count == 3
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_herring_touches_no_drill_item(test_engine) -> None:
    """A red-herring solve writes a drill_solves row and creates/modifies no drill_items row."""
    email = f"train-herring-solve-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_bare_game(test_engine, user_id, "herring-solve")
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, 8, int(DrillSource.RED_HERRING))]
    )

    try:
        before = await _count_drill_items(test_engine, user_id)
        resp = await _solve(token, session_id, 0, guess="several", move_quality="good")
        assert resp.status_code == 200
        body = resp.json()
        assert body["item_status"] is None
        assert body["streak"] is None
        assert body["due_date"] is None
        after = await _count_drill_items(test_engine, user_id)
        assert after == before
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "pv_lines,expected_puzzle_type,guess,expected_correct_guess",
    [
        (_SHARP_PV_LINES, "sharp", "critical", True),
        (_SHARP_PV_LINES, "sharp", "several", False),
        (_MISSED_PV_LINES, "soft", "several", True),
        (_MISSED_PV_LINES, "soft", "critical", False),
    ],
)
async def test_correct_guess_computed_server_side(
    test_engine,
    pv_lines: list,
    expected_puzzle_type: str,
    guess: str,
    expected_correct_guess: bool,
) -> None:
    """P-02: the guess verdict is graded server-side from the live blob, never client-asserted."""
    assert "correct_guess" not in SolveRequest.model_fields
    assert "puzzle_type" not in SolveRequest.model_fields

    email = f"train-guess-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, missed_pv_lines=pv_lines)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 0, guess=guess, move_quality="good")
        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_type"] == expected_puzzle_type
        assert body["correct_guess"] is expected_correct_guess
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_is_idempotent_per_position(test_engine) -> None:
    """Re-submitting the same (session_id, position) returns the first recorded result."""
    email = f"train-idem-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=0)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        first = await _solve(
            token, session_id, 0, guess="critical", played_move="e2e4", move_quality="good"
        )
        assert first.status_code == 200
        second = await _solve(
            token, session_id, 0, guess="several", played_move="d2d4", move_quality="wrong"
        )
        assert second.status_code == 200

        assert second.json()["correct_move"] == first.json()["correct_move"]
        assert second.json()["correct_guess"] == first.json()["correct_guess"]
        assert second.json()["streak"] == first.json()["streak"]

        item = await _get_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
        assert item is not None
        assert item.streak == 1  # advanced exactly once, never re-advanced or reset
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_concurrent_solve_advances_streak_once(test_engine) -> None:
    """T-189-19: two concurrent solves of the same puzzle advance the streak exactly once."""
    email = f"train-concurrent-solve-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE, streak=0)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        payload = {
            "position": 0,
            "guess": "critical",
            "played_move": "e2e4",
            "move_quality": "good",
        }
        async with (
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client_a,
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client_b,
        ):
            resp_a, resp_b = await asyncio.gather(
                client_a.post(
                    f"/api/train/sessions/{session_id}/solve",
                    headers={"Authorization": f"Bearer {token}"},
                    json=payload,
                ),
                client_b.post(
                    f"/api/train/sessions/{session_id}/solve",
                    headers={"Authorization": f"Bearer {token}"},
                    json=payload,
                ),
            )
        assert resp_a.status_code == 200
        assert resp_b.status_code == 200

        item = await _get_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
        assert item is not None
        assert item.streak == 1
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_foreign_session_404(test_engine) -> None:
    """A session_id belonging to another user returns 404, not that user's data (T-189-16)."""
    email_a = f"train-owner-{uuid.uuid4().hex[:8]}@example.com"
    user_a, token_a = await _register_and_login(email_a)
    email_b = f"train-attacker-{uuid.uuid4().hex[:8]}@example.com"
    _user_b, token_b = await _register_and_login(email_b)

    game_id = await _seed_game_with_blunder(test_engine, user_a)
    await _seed_drill_item(test_engine, user_a, game_id, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine, user_a, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token_b, session_id, 0, move_quality="good")
        assert resp.status_code == 404
        body = resp.json()
        assert "correct_guess" not in body
        assert "streak" not in body
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_solve_unknown_position_404(test_engine) -> None:
    """A position outside the session's frozen list returns 404."""
    email = f"train-badpos-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _solve(token, session_id, 5, move_quality="good")
        assert resp.status_code == 404
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_last_solve_completes_session(test_engine) -> None:
    """Recording the last outstanding puzzle sets the session to completed."""
    email = f"train-complete-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id_sr = await _seed_game_with_blunder(test_engine, user_id, ply=_FLAW_PLY_WHITE)
    game_id_herring = await _seed_bare_game(test_engine, user_id, "complete-herring")
    await _seed_drill_item(test_engine, user_id, game_id_sr, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine,
        user_id,
        [
            (game_id_sr, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM)),
            (game_id_herring, 8, int(DrillSource.RED_HERRING)),
        ],
    )

    try:
        first = await _solve(token, session_id, 0, move_quality="good")
        assert first.status_code == 200
        assert first.json()["session_complete"] is False
        assert await _get_session_status(test_engine, session_id) == "open"

        second = await _solve(token, session_id, 1, guess="several", move_quality="good")
        assert second.status_code == 200
        assert second.json()["session_complete"] is True
        assert await _get_session_status(test_engine, session_id) == "completed"
    finally:
        await _delete_games(test_engine, [game_id_sr, game_id_herring])


@pytest.mark.asyncio
async def test_session_completes_when_sr_item_flaw_row_vanishes_under_reclassification(
    test_engine,
) -> None:
    """WR-02 fix: an SR-source puzzle whose backing `game_flaws` row is
    reclassified away (lazy eviction, mirroring `load_session_puzzles`'s own
    posture) must not block session completion forever, even though its
    `drill_solves` row stays `solved_at IS NULL`. Deleting the `GameFlaw` row
    directly simulates the delete-then-insert reclassify path documented on
    `pool_entry_stmt`/`compose_and_materialize_session`.
    """
    email = f"train-complete-evicted-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id_sr = await _seed_game_with_blunder(test_engine, user_id, ply=_FLAW_PLY_WHITE)
    game_id_herring = await _seed_bare_game(test_engine, user_id, "complete-evicted-herring")
    await _seed_drill_item(test_engine, user_id, game_id_sr, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine,
        user_id,
        [
            (game_id_sr, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM)),
            (game_id_herring, 8, int(DrillSource.RED_HERRING)),
        ],
    )

    # Simulate reclassification evicting the SR item's backing flaw row —
    # its drill_solves row (position 0) now stays solved_at IS NULL forever,
    # since load_session_puzzles will never serve it again.
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            await session.execute(
                delete(GameFlaw).where(
                    GameFlaw.user_id == user_id,
                    GameFlaw.game_id == game_id_sr,
                    GameFlaw.ply == _FLAW_PLY_WHITE,
                )
            )

    try:
        # Only the herring (position 1) is servable now — solving it must
        # complete the session, not leave it "open" forever waiting on the
        # now-unreachable SR item.
        resp = await _solve(token, session_id, 1, guess="several", move_quality="good")
        assert resp.status_code == 200
        assert resp.json()["session_complete"] is True
        assert await _get_session_status(test_engine, session_id) == "completed"
    finally:
        await _delete_games(test_engine, [game_id_sr, game_id_herring])


# ---------------------------------------------------------------------------
# Plan 05 Task 2 — GET /sessions/{session_id}/puzzles/{position}/reveal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reveal_409_before_attempt(test_engine) -> None:
    """The reveal gate returns 409 with no answer-key fields before the attempt (T-189-17)."""
    email = f"train-reveal-409-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _reveal(token, session_id, 0)
        assert resp.status_code == 409
        body = resp.json()
        assert "best_move" not in body
        assert "puzzle_type" not in body
        assert "pv" not in body  # 190-02: the stored best line is no exception to the gate
        # 190.1-01: the game move's UCI counterpart is no exception either.
        assert "played_in_game_move_uci" not in body
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_reveal_played_in_game_move_uci_normal_move(test_engine) -> None:
    """A normal (4-char) move_san reveals its 4-character UCI (190.1-01, D-05)."""
    email = f"train-reveal-uci-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, missed_pv_lines=_SHARP_PV_LINES)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    await _seed_position_meta(
        test_engine, user_id, game_id, _FLAW_PLY_WHITE, best_move="b5a4", move_san="Ba4"
    )
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        solved = await _solve(token, session_id, 0, guess="critical", move_quality="good")
        assert solved.status_code == 200

        resp = await _reveal(token, session_id, 0)
        assert resp.status_code == 200
        body = resp.json()
        assert body["played_in_game_san"] == "Ba4"
        assert body["played_in_game_move_uci"] == "b5a4"
    finally:
        await _delete_games(test_engine, [game_id])


# A classic double-pawn-promotion race: at ply 8 (before White's 5th move),
# White's g7 pawn can only promote by capturing the still-unmoved h8 rook —
# "gxh8=Q" -> UCI "g7h8q" (5 chars), the promotion case the 4-char normal-move
# test above cannot exercise.
_PROMOTION_PGN = "1. h4 a5 2. h5 a4 3. h6 a3 4. hxg7 axb2 5. gxh8=Q bxa1=Q *"
_PROMOTION_PLY = 8


@pytest.mark.asyncio
async def test_reveal_played_in_game_move_uci_promotion(test_engine) -> None:
    """A 5-char promotion move_san reveals its 5-character UCI (190.1-01, D-05).

    Phase 192 (D-03): a red herring's reveal FEN now comes EXCLUSIVELY off
    its `herring_pool` row (never `game.pgn`), so this uses an SR item — the
    source this PGN-derived-FEN path still applies to — rather than the
    RED_HERRING source the pre-Phase-192 version of this test used. The UCI
    derivation logic under test is source-agnostic.
    """
    email = f"train-reveal-uci-promo-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_pgn(test_engine, user_id, _PROMOTION_PGN, "promo")
    await _seed_drill_item(test_engine, user_id, game_id, _PROMOTION_PLY)
    await _seed_position_meta(
        test_engine, user_id, game_id, _PROMOTION_PLY, best_move="g7h8q", move_san="gxh8=Q"
    )
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _PROMOTION_PLY, int(DrillSource.SR_ITEM))]
    )

    try:
        solved = await _solve(token, session_id, 0, guess="several", move_quality="good")
        assert solved.status_code == 200

        resp = await _reveal(token, session_id, 0)
        assert resp.status_code == 200
        body = resp.json()
        assert body["played_in_game_san"] == "gxh8=Q"
        assert body["played_in_game_move_uci"] == "g7h8q"
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_reveal_200_after_attempt(test_engine) -> None:
    """Once solved, reveal returns 200 with the correct puzzle_type/source.

    190.1-03: no best_move/best_move_san/pv assertions here — see
    test_reveal_key_set_excludes_stored_answer_key_fields for the standing
    exact-key-set assertion covering their removal.
    """
    email = f"train-reveal-200-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, missed_pv_lines=_SHARP_PV_LINES)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    await _seed_position_meta(
        test_engine, user_id, game_id, _FLAW_PLY_WHITE, best_move="b5a4", move_san="Ba4"
    )
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        solved = await _solve(token, session_id, 0, guess="critical", move_quality="good")
        assert solved.status_code == 200

        resp = await _reveal(token, session_id, 0)
        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_type"] == "sharp"
        assert body["source"] == "sr_item"
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_reveal_key_set_excludes_stored_answer_key_fields(test_engine) -> None:
    """190.1-03 T-190.1-12: the reveal response's key set is the standing assertion
    that no stored engine line/eval (best_move/best_move_san/pv) ever creeps
    back in — the client grading engine is the sole source of those numbers.
    """
    email = f"train-reveal-keyset-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id, missed_pv_lines=_SHARP_PV_LINES)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    await _seed_position_meta(
        test_engine, user_id, game_id, _FLAW_PLY_WHITE, best_move="b5a4", move_san="Ba4"
    )
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        solved = await _solve(token, session_id, 0, guess="critical", move_quality="good")
        assert solved.status_code == 200

        resp = await _reveal(token, session_id, 0)
        assert resp.status_code == 200
        assert set(resp.json().keys()) == {
            "game_id",
            "ply",
            "fen",
            "played_in_game_san",
            "played_in_game_move_uci",
            "puzzle_type",
            "source",
            "has_tactic_lines",
        }
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_reveal_herring_reports_herring_type(test_engine) -> None:
    """A solved red herring reveals puzzle_type "herring" and source "red_herring"."""
    email = f"train-reveal-herring-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_bare_game(test_engine, user_id, "reveal-herring")
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, 8, int(DrillSource.RED_HERRING))]
    )

    try:
        solved = await _solve(token, session_id, 0, guess="several", move_quality="good")
        assert solved.status_code == 200

        resp = await _reveal(token, session_id, 0)
        assert resp.status_code == 200
        body = resp.json()
        assert body["puzzle_type"] == "herring"
        assert body["source"] == "red_herring"
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_reveal_cross_user_herring_shows_game_move_and_no_owner_scope_leak(
    test_engine,
) -> None:
    """D-06/T-192-02: a herring drawn from user B's game, solved by user A,
    reveals with B's in-game move — the `GamePosition` lookup resolves the
    source game's OWNER (`game.user_id`), not the solving user, so it no
    longer silently degrades to `played_in_game_san: null` for a cross-user
    herring even though B's game row is perfectly alive. The response key
    set stays exactly the standing `PuzzleRevealResponse` contract — no
    stranger's data leaks through beyond the one `move_san` field the D-06
    widening exists to expose.
    """
    email_a = f"train-herring-crossuser-a-{uuid.uuid4().hex[:8]}@example.com"
    user_a, token_a = await _register_and_login(email_a)
    email_b = f"train-herring-crossuser-b-{uuid.uuid4().hex[:8]}@example.com"
    user_b, _token_b = await _register_and_login(email_b)

    game_id_b = await _seed_bare_game(test_engine, user_b, "crossuser-herring")
    await _seed_position_meta(test_engine, user_b, game_id_b, 8, best_move="e2e4", move_san="e4")
    pool_id = await _seed_herring_pool_row(
        test_engine,
        user_b,
        game_id_b,
        8,
        fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        arriving_move_uci="d7d5",
    )
    session_id = await _seed_session(
        test_engine,
        user_a,
        [(game_id_b, 8, int(DrillSource.RED_HERRING))],
        herring_pool_ids={0: pool_id},
    )

    try:
        solved = await _solve(token_a, session_id, 0, guess="several", move_quality="good")
        assert solved.status_code == 200

        resp = await _reveal(token_a, session_id, 0)
        assert resp.status_code == 200
        body = resp.json()
        # B's game move is shown, not degraded to None — this is the exact
        # D-06 bug fix: the pre-widening filter (GamePosition.user_id ==
        # solving user) would have returned no row for a foreign game.
        assert body["played_in_game_san"] == "e4"
        assert body["played_in_game_move_uci"] == "e2e4"
        # No field beyond the standing contract — the widened lookup selects
        # exactly move_san server-side; nothing else about B's game leaks.
        assert set(body.keys()) == {
            "game_id",
            "ply",
            "fen",
            "played_in_game_san",
            "played_in_game_move_uci",
            "puzzle_type",
            "source",
            "has_tactic_lines",
        }
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_id])
        await _delete_games(test_engine, [game_id_b])


@pytest.mark.asyncio
async def test_reveal_survives_source_game_deletion(test_engine) -> None:
    """D-01/D-03/D-05: a herring's source game deletion nulls `game_id` (real
    `ON DELETE SET NULL`) but the reveal still succeeds — FEN comes off the
    `herring_pool` row, `game_id` reports `None`, and `played_in_game_san`
    degrades to `None` (D-08) rather than the reveal 404ing.
    """
    email = f"train-reveal-orphan-herring-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_bare_game(test_engine, user_id, "reveal-orphan-herring")
    pool_id = await _seed_herring_pool_row(
        test_engine,
        user_id,
        game_id,
        8,
        fen="8/8/8/8/8/8/8/K6k w - - 0 1",
        arriving_move_uci="a1a2",
    )
    session_id = await _seed_session(
        test_engine,
        user_id,
        [(game_id, 8, int(DrillSource.RED_HERRING))],
        herring_pool_ids={0: pool_id},
    )

    try:
        solved = await _solve(token, session_id, 0, guess="several", move_quality="good")
        assert solved.status_code == 200

        # Delete the source game via the real FK policy — never null the
        # column by hand, which would prove nothing about ON DELETE SET NULL.
        await _delete_games(test_engine, [game_id])

        resp = await _reveal(token, session_id, 0)
        assert resp.status_code == 200
        body = resp.json()
        assert body["game_id"] is None
        assert body["fen"] == "8/8/8/8/8/8/8/K6k w - - 0 1"
        assert body["played_in_game_san"] is None
        assert body["played_in_game_move_uci"] is None
        assert body["puzzle_type"] == "herring"
        assert body["source"] == "red_herring"
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_id])


@pytest.mark.asyncio
async def test_reveal_orphaned_sr_row_returns_not_found(test_engine) -> None:
    """D-05: an SR item solved BEFORE its source game is deleted returns
    `"not_found"` on reveal after the deletion — the exact pre-D-05 CASCADE
    outcome (the whole `drill_solves` row, and therefore this query's
    result, used to not exist at all). There is no "reveal an orphaned SR
    item" state; the puzzle simply cannot be re-shown once its source game
    is gone.
    """
    email = f"train-reveal-orphan-sr-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    solved = await _solve(token, session_id, 0, guess="critical", move_quality="good")
    assert solved.status_code == 200

    # Delete the source game via the real FK policy AFTER the solve is
    # already recorded — never null the column by hand.
    await _delete_games(test_engine, [game_id])

    resp = await _reveal(token, session_id, 0)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_reveal_foreign_session_404(test_engine) -> None:
    """A session id belonging to a second registered user returns 404 (T-189-16)."""
    email_a = f"train-reveal-owner-{uuid.uuid4().hex[:8]}@example.com"
    user_a, token_a = await _register_and_login(email_a)
    email_b = f"train-reveal-attacker-{uuid.uuid4().hex[:8]}@example.com"
    _user_b, token_b = await _register_and_login(email_b)

    game_id = await _seed_game_with_blunder(test_engine, user_a)
    await _seed_drill_item(test_engine, user_a, game_id, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine, user_a, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        solved = await _solve(token_a, session_id, 0, move_quality="good")
        assert solved.status_code == 200

        resp = await _reveal(token_b, session_id, 0)
        assert resp.status_code == 404
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_reveal_unknown_position_404(test_engine) -> None:
    """A position outside the session's frozen list returns 404."""
    email = f"train-reveal-badpos-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, game_id, _FLAW_PLY_WHITE)
    session_id = await _seed_session(
        test_engine, user_id, [(game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )

    try:
        resp = await _reveal(token, session_id, 5)
        assert resp.status_code == 404
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_reveal_has_tactic_lines_flag(test_engine) -> None:
    """has_tactic_lines flips True only when the flaw carries a tactic tag."""
    email = f"train-reveal-tactic-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)

    tagged_game_id = await _seed_game_with_blunder(test_engine, user_id, missed_tactic_motif=1)
    await _seed_drill_item(test_engine, user_id, tagged_game_id, _FLAW_PLY_WHITE)
    session_tagged = await _seed_session(
        test_engine, user_id, [(tagged_game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )
    solved_tagged = await _solve(token, session_tagged, 0, move_quality="good")
    assert solved_tagged.status_code == 200
    # Single-puzzle session -> immediately completed, freeing the D-12
    # at-most-one-open-session slot before the second session is seeded.
    assert solved_tagged.json()["session_complete"] is True

    untagged_game_id = await _seed_game_with_blunder(test_engine, user_id)
    await _seed_drill_item(test_engine, user_id, untagged_game_id, _FLAW_PLY_WHITE)
    session_untagged = await _seed_session(
        test_engine, user_id, [(untagged_game_id, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM))]
    )
    solved_untagged = await _solve(token, session_untagged, 0, move_quality="good")
    assert solved_untagged.status_code == 200

    try:
        tagged_resp = await _reveal(token, session_tagged, 0)
        untagged_resp = await _reveal(token, session_untagged, 0)

        assert tagged_resp.status_code == 200
        assert untagged_resp.status_code == 200
        assert tagged_resp.json()["has_tactic_lines"] is True
        assert untagged_resp.json()["has_tactic_lines"] is False
    finally:
        await _delete_games(test_engine, [tagged_game_id, untagged_game_id])


# ---------------------------------------------------------------------------
# Plan 05 Task 3 — GET/PUT /train/settings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_settings_creates_defaults_on_first_touch(test_engine) -> None:
    """First GET creates and returns the D-06/D-07/D-08 defaults in one call."""
    email = f"train-settings-default-{uuid.uuid4().hex[:8]}@example.com"
    _user_id, token = await _register_and_login(email)

    resp = await _get_settings(token)
    assert resp.status_code == 200
    # 191-06: defaults changed from (weekday_mask=0, puzzles_per_session=12)
    # to (127, 6) — see app.services.train_scheduler.DEFAULT_WEEKDAY_MASK.
    assert resp.json() == {"timezone": "UTC", "weekday_mask": 127, "puzzles_per_session": 6}


@pytest.mark.asyncio
async def test_get_settings_is_idempotent(test_engine) -> None:
    """Two GETs create exactly one train_settings row."""
    from app.models.train_settings import TrainSettings

    email = f"train-settings-idem-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)

    first = await _get_settings(token)
    second = await _get_settings(token)
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        count = (
            await session.execute(
                select(func.count())
                .select_from(TrainSettings)
                .where(TrainSettings.user_id == user_id)
            )
        ).scalar_one()
    assert count == 1


@pytest.mark.asyncio
async def test_put_settings_persists_and_round_trips(test_engine) -> None:
    """A PUT persists and a subsequent GET returns exactly what was stored."""
    email = f"train-settings-put-{uuid.uuid4().hex[:8]}@example.com"
    _user_id, token = await _register_and_login(email)

    put_resp = await _put_settings(
        token, timezone="America/New_York", weekday_mask=0b0010101, puzzles_per_session=8
    )
    assert put_resp.status_code == 200
    assert put_resp.json() == {
        "timezone": "America/New_York",
        "weekday_mask": 0b0010101,
        "puzzles_per_session": 8,
    }

    get_resp = await _get_settings(token)
    assert get_resp.status_code == 200
    assert get_resp.json() == put_resp.json()


@pytest.mark.asyncio
async def test_put_settings_rejects_bad_timezone_422(test_engine) -> None:
    """An unresolvable IANA timezone is rejected 422 and never persisted."""
    email = f"train-settings-badtz-{uuid.uuid4().hex[:8]}@example.com"
    _user_id, token = await _register_and_login(email)

    good = await _put_settings(
        token, timezone="Europe/Zurich", weekday_mask=0, puzzles_per_session=12
    )
    assert good.status_code == 200

    bad = await _put_settings(token, timezone="Not/AZone", weekday_mask=0, puzzles_per_session=12)
    assert bad.status_code == 422

    get_resp = await _get_settings(token)
    assert get_resp.json()["timezone"] == "Europe/Zurich"


@pytest.mark.asyncio
async def test_put_settings_rejects_out_of_range_mask_422(test_engine) -> None:
    """A weekday_mask outside [0, 127] is rejected 422."""
    email = f"train-settings-badmask-{uuid.uuid4().hex[:8]}@example.com"
    _user_id, token = await _register_and_login(email)

    resp = await _put_settings(token, timezone="UTC", weekday_mask=128, puzzles_per_session=12)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_settings_403_guest(test_engine) -> None:
    """A guest account is rejected 403 on both GET and PUT /train/settings."""
    email = f"train-settings-guest-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    await _set_guest(test_engine, user_id)

    get_resp = await _get_settings(token)
    assert get_resp.status_code == 403

    put_resp = await _put_settings(token, timezone="UTC", weekday_mask=0, puzzles_per_session=12)
    assert put_resp.status_code == 403


@pytest.mark.asyncio
async def test_session_size_follows_settings(test_engine) -> None:
    """Setting puzzles_per_session=4 composes a session of at most 4 puzzles."""
    email = f"train-settings-size-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)

    put_resp = await _put_settings(token, timezone="UTC", weekday_mask=0, puzzles_per_session=4)
    assert put_resp.status_code == 200

    game_ids = [
        await _seed_game_with_blunder(test_engine, user_id, ply=_FLAW_PLY_WHITE) for _ in range(6)
    ]

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["requested_count"] == 4
        assert len(body["puzzles"]) <= 4
    finally:
        await _delete_games(test_engine, game_ids)


@pytest.mark.asyncio
async def test_untouched_open_session_recomposes_after_size_change(test_engine) -> None:
    """UAT bug fix (191-06 checkpoint round): `Train.tsx` auto-fires
    `POST /train/sessions` as a status read on page MOUNT (see
    `useTrainSession.ts`'s module docstring) — BEFORE the user has a chance
    to edit `TrainScheduleSettings` on the same visit. Pressing Start/Resume
    never calls the endpoint again, so a session materialized under the OLD
    `puzzles_per_session` stayed frozen at its original size even after the
    setting changed, as long as nothing had been solved yet.

    This seeds a fake open session directly (bypassing composition, mirroring
    what an earlier mount-time compose call under a stale setting would have
    produced), changes the setting, then calls the endpoint again exactly as
    a second real page load / "Start session" click would. An untouched
    (zero solved) session whose puzzle_count no longer matches the CURRENT
    setting must be discarded and recomposed — not resumed verbatim.
    """
    email = f"train-settings-recompose-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)

    # Ten distinct qualifying blunders — enough pool material for either a
    # 10-puzzle or a 6-puzzle composition, with no herring rows seeded (cross-
    # backfill pulls the shortfall from the SR side, precedent:
    # test_session_size_follows_settings).
    game_ids = [
        await _seed_game_with_blunder(test_engine, user_id, ply=_FLAW_PLY_WHITE) for _ in range(10)
    ]

    try:
        # Fake the "already composed at mount, under a size-10 setting"
        # session: an open drill_sessions row with 10 unsolved drill_solves,
        # entirely untouched (no solve has ever been recorded), with
        # requested_count=10 set explicitly (mirrors exactly what a real
        # `compose_and_materialize_session` call under puzzles_per_session=10
        # would have persisted).
        stale_entries = [(gid, _FLAW_PLY_WHITE, int(DrillSource.SR_ITEM)) for gid in game_ids]
        await _seed_session(test_engine, user_id, stale_entries, requested_count=10)

        # The user now edits TrainScheduleSettings on the same visit, AFTER
        # the stale session above was already materialized.
        put_resp = await _put_settings(token, timezone="UTC", weekday_mask=0, puzzles_per_session=6)
        assert put_resp.status_code == 200

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(ENDPOINT, headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["requested_count"] == 6
        assert body["puzzle_count"] == 6
        assert len(body["puzzles"]) == 6
    finally:
        await _delete_games(test_engine, game_ids)


# ---------------------------------------------------------------------------
# Phase 193 (PROG-01/PROG-04, per-day tick + depletable shield) —
# GET /train/progress
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_progress_returns_200_with_all_eleven_fields(test_engine) -> None:
    """An authenticated non-guest account gets 200 with every response field."""
    email = f"train-progress-ok-{uuid.uuid4().hex[:8]}@example.com"
    _user_id, token = await _register_and_login(email)

    resp = await _get_progress(token)
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {
        "session_streak_count",
        "shield_level",
        "current_week_completed",
        "current_week_required",
        "streak_reset_notice",
        "mastered_count",
        "parked_count",
        "waiting_count",
        "pool_state",
        "next_due_date",
        "badge_visible",
    }
    assert body["pool_state"] in ("no_material", "exhausted", "available")
    # A brand-new account: empty shield, nothing settled, no counts yet, and
    # no material at all -> the cold-start empty state.
    assert body["session_streak_count"] == 0
    assert body["shield_level"] == 0
    assert body["streak_reset_notice"] is False
    assert body["mastered_count"] == 0
    assert body["parked_count"] == 0
    assert body["waiting_count"] == 0
    assert body["pool_state"] == "no_material"
    assert body["next_due_date"] is None
    # (Plan 02, D-09/D-10) waiting_count == 0 -> badge_visible is always
    # False regardless of schedule; still assert its type here since a
    # brand-new account is the cheapest place to pin "key present, boolean".
    assert isinstance(body["badge_visible"], bool)
    assert body["badge_visible"] is False


@pytest.mark.asyncio
async def test_put_settings_settles_elapsed_days_with_old_mask_before_get(test_engine) -> None:
    """End-to-end settle-before-mutate: an elapsed day judged under the OLD
    dense default weekday_mask settles into the streak BEFORE a PUT installs
    a stricter 3-scheduled-day mask, and a subsequent GET /train/progress
    reports that OLD-mask judgment."""
    email = f"train-settle-mutate-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)

    # A single day whose window has closed relative to real wall-clock
    # "now" (yesterday) — one judged day is sufficient to prove the
    # settle-before-mutate ordering without needing a multi-day walk.
    now_for_seed = datetime.datetime.now(datetime.timezone.utc)
    yesterday = now_for_seed.date() - datetime.timedelta(days=1)
    await _seed_completed_session_router(test_engine, user_id, yesterday)
    await _seed_pool_eligible_since_router(test_engine, user_id, yesterday)

    put_resp = await _put_settings(
        token,
        timezone="UTC",
        weekday_mask=(1 << 0) | (1 << 2) | (1 << 4),  # 3 scheduled days
        puzzles_per_session=12,
    )
    assert put_resp.status_code == 200

    progress_resp = await _get_progress(token)
    assert progress_resp.status_code == 200
    assert progress_resp.json()["session_streak_count"] == 1


@pytest.mark.asyncio
async def test_progress_403_guest(test_engine) -> None:
    """A guest account is rejected 403 before any progress query runs (D-05)."""
    email = f"train-progress-guest-{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    await _set_guest(test_engine, user_id)

    resp = await _get_progress(token)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Train requires a full account"
