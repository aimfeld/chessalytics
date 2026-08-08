"""Tests for store_paste_game_service.store_pasted_game (Phase 208, PASTE-04/06/07).

Covers every <behavior> bullet of 208-03-PLAN.md Task 1: the reuse-or-insert
identity flow (D-16/D-17/D-18), the single-commit persistence path, the
post-commit tier-1 enqueue, and the SC-7 post-commit enqueue-failure window.

Data isolation: unlike the rollback-scoped `db_session` fixture used
elsewhere, `enqueue_tier1_game` opens its OWN session via
`async_session_maker()` (patched to `test_session_maker` by
`override_get_async_session`, session-scoped autouse) — a DIFFERENT
connection from a savepoint-scoped `db_session`. A row inserted through
`db_session` is invisible to that second connection until the OUTER
connection-level transaction actually commits, which `db_session` never
does (it always rolls back at teardown). So this module uses a genuinely
COMMITTING session (mirrors `tests/conftest.py`'s `fresh_test_user` pattern)
and cleans up every inserted non-guest `Game` row in a `finally` block —
the tier-3 eval lottery is global and random, and a leaked needs-engine row
flakes unrelated lottery tests.
"""

from __future__ import annotations

import uuid
from typing import Literal
from unittest.mock import patch

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.eval_jobs import EvalJob
from app.models.game import Game
from app.models.user import User
from app.schemas.imports import SavePastedGameRequest
from app.services.normalization import normalize_pasted_game
from app.services.store_paste_game_service import _PASTE_PLATFORM, store_pasted_game
from tests.conftest import ensure_test_user

_TEST_USER_ID = 92600  # unique ID range for this test module
_OTHER_USER_ID = 92650

_PGN_SCHOLARS_MATE = (
    '[Event "Casual game"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n'
    "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n"
)

# A materially different mainline for the two-users / other-game scenarios.
_PGN_QUEENS_GAMBIT = (
    '[Event "Casual game"]\n[White "Carol"]\n[Black "Dave"]\n[Result "1/2-1/2"]\n\n'
    "1. d4 d5 2. c4 e6 1/2-1/2\n"
)

# No recognized [Result] header and a non-terminal final board -> None
# (normalize_pasted_game's expected-validation-failure case).
_PGN_UNFINISHED = '[Event "Casual game"]\n\n1. e4 e5 2. Nf3 Nc6 *\n'


def _make_request(
    *,
    pgn: str = _PGN_SCHOLARS_MATE,
    user_color: Literal["white", "black"] = "white",
) -> SavePastedGameRequest:
    return SavePastedGameRequest(pgn=pgn, user_color=user_color)


class _CommittingSession:
    """Async context manager yielding a genuinely-committing AsyncSession.

    Deletes every Game row it created for the given user_ids on exit
    (cascade-deletes eval_jobs via ondelete=CASCADE).
    """

    def __init__(self, test_engine, user_ids: list[int]) -> None:
        self._session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        self._user_ids = user_ids
        self._session: AsyncSession | None = None

    async def __aenter__(self) -> AsyncSession:
        self._session = self._session_maker()
        for user_id in self._user_ids:
            await ensure_test_user(self._session, user_id)
        await self._session.commit()
        return self._session

    async def __aexit__(self, *exc_info: object) -> None:
        assert self._session is not None
        await self._session.execute(delete(Game).where(Game.user_id.in_(self._user_ids)))
        await self._session.commit()
        await self._session.close()


async def _count_pgn_rows(session: AsyncSession, user_id: int) -> int:
    result = await session.execute(
        select(func.count())
        .select_from(Game)
        .where(Game.user_id == user_id, Game.platform == _PASTE_PLATFORM)
    )
    return result.scalar_one()


async def _count_eval_jobs(session: AsyncSession, game_id: int) -> int:
    result = await session.execute(
        select(func.count()).select_from(EvalJob).where(EvalJob.game_id == game_id)
    )
    return result.scalar_one()


class TestStorePastedGame:
    async def test_valid_pgn_creates_row_and_enqueues(self, test_engine) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            response = await store_pasted_game(session, _TEST_USER_ID, _make_request())

            assert response is not None
            assert response.created is True
            assert response.eval_status == "enqueued"
            assert await _count_pgn_rows(session, _TEST_USER_ID) == 1

    async def test_reposting_identical_pgn_reuses_row(self, test_engine) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            first = await store_pasted_game(session, _TEST_USER_ID, _make_request())
            second = await store_pasted_game(session, _TEST_USER_ID, _make_request())

            assert first is not None
            assert second is not None
            assert first.created is True
            assert second.created is False
            assert second.game_id == first.game_id
            assert await _count_pgn_rows(session, _TEST_USER_ID) == 1

    async def test_reposting_with_other_color_updates_user_color_in_place(
        self, test_engine
    ) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            first = await store_pasted_game(
                session, _TEST_USER_ID, _make_request(user_color="white")
            )
            second = await store_pasted_game(
                session, _TEST_USER_ID, _make_request(user_color="black")
            )

            assert first is not None
            assert second is not None
            assert second.created is False
            assert second.game_id == first.game_id

            game = await session.get(Game, second.game_id)
            assert game is not None
            assert game.user_color == "black"
            assert await _count_pgn_rows(session, _TEST_USER_ID) == 1

    async def test_two_users_posting_same_pgn_get_different_rows(self, test_engine) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID, _OTHER_USER_ID]) as session:
            first = await store_pasted_game(session, _TEST_USER_ID, _make_request())
            second = await store_pasted_game(session, _OTHER_USER_ID, _make_request())

            assert first is not None
            assert second is not None
            assert first.game_id != second.game_id

    async def test_invalid_pgn_returns_none(self, test_engine) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            response = await store_pasted_game(
                session, _TEST_USER_ID, _make_request(pgn=_PGN_UNFINISHED)
            )
            assert response is None
            assert await _count_pgn_rows(session, _TEST_USER_ID) == 0

    async def test_already_analyzed_row_skips_reenqueue(self, test_engine) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            first = await store_pasted_game(session, _TEST_USER_ID, _make_request())
            assert first is not None
            assert first.eval_status == "enqueued"

            game = await session.get(Game, first.game_id)
            assert game is not None
            import datetime

            game.full_evals_completed_at = datetime.datetime.now(datetime.timezone.utc)
            await session.commit()

            jobs_before = await _count_eval_jobs(session, first.game_id)

            second = await store_pasted_game(session, _TEST_USER_ID, _make_request())
            assert second is not None
            assert second.eval_status == "already_analyzed"
            assert second.game_id == first.game_id

            jobs_after = await _count_eval_jobs(session, first.game_id)
            assert jobs_after == jobs_before

    async def test_enqueue_failure_returns_enqueue_failed_and_row_survives(
        self, test_engine
    ) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            with (
                patch(
                    "app.services.store_paste_game_service.enqueue_tier1_game",
                    side_effect=RuntimeError("boom"),
                ),
                patch(
                    "app.services.store_paste_game_service.sentry_sdk.capture_exception"
                ) as mock_capture,
            ):
                response = await store_pasted_game(session, _TEST_USER_ID, _make_request())

            assert response is not None
            assert response.created is True
            assert response.eval_status == "enqueue_failed"
            mock_capture.assert_called_once()

            # The row IS durably committed despite the enqueue exception.
            assert await _count_pgn_rows(session, _TEST_USER_ID) == 1
            game = await session.get(Game, response.game_id)
            assert game is not None

    async def test_enqueue_failure_heals_on_resubmit(self, test_engine) -> None:
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            with patch(
                "app.services.store_paste_game_service.enqueue_tier1_game",
                side_effect=RuntimeError("boom"),
            ):
                first = await store_pasted_game(session, _TEST_USER_ID, _make_request())
            assert first is not None
            assert first.eval_status == "enqueue_failed"

            # Un-patched resubmit resolves to the same row and heals.
            second = await store_pasted_game(session, _TEST_USER_ID, _make_request())
            assert second is not None
            assert second.game_id == first.game_id
            assert second.created is False
            assert second.eval_status == "enqueued"
            assert await _count_pgn_rows(session, _TEST_USER_ID) == 1

    async def test_preexisting_identical_row_resolves_without_integrity_error(
        self, test_engine
    ) -> None:
        """A concurrent-duplicate simulation: pre-insert the identical row (by
        the same D-16 identity the service would compute), then invoke the
        service and assert a 2xx-shaped result with the pre-existing
        game_id — never an IntegrityError.
        """
        async with _CommittingSession(test_engine, [_TEST_USER_ID]) as session:
            normalized = normalize_pasted_game(_PGN_SCHOLARS_MATE, _TEST_USER_ID, "white")
            assert normalized is not None

            pre_existing = Game(
                user_id=_TEST_USER_ID,
                platform=_PASTE_PLATFORM,
                platform_game_id=normalized.platform_game_id,
                platform_url=None,
                pgn=normalized.pgn,
                result=normalized.result,
                user_color="white",
                termination_raw=normalized.termination_raw,
                termination=normalized.termination,
                rated=False,
                is_computer_game=False,
                white_username=normalized.white_username,
                black_username=normalized.black_username,
            )
            session.add(pre_existing)
            await session.commit()
            pre_existing_id = pre_existing.id

            response = await store_pasted_game(session, _TEST_USER_ID, _make_request())

            assert response is not None
            assert response.created is False
            assert response.game_id == pre_existing_id
            assert await _count_pgn_rows(session, _TEST_USER_ID) == 1

    async def test_guest_can_save_and_enqueue_own_pasted_game(self, test_engine) -> None:
        """QUEUE-08 tier-1 carve-out: a guest can save + enqueue their own
        pasted game exactly as they already can for an imported game.
        """
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        guest_user_id = 92699
        async with session_maker() as session:
            existing = (
                await session.execute(select(User).where(User.id == guest_user_id))
            ).scalar_one_or_none()
            if existing is None:
                session.add(
                    User(
                        id=guest_user_id,
                        email=f"guest-test-{uuid.uuid4()}@example.com",
                        hashed_password="fakehash",
                        is_guest=True,
                    )
                )
            await session.commit()

            try:
                response = await store_pasted_game(session, guest_user_id, _make_request())
                assert response is not None
                assert response.eval_status == "enqueued"
                assert await _count_pgn_rows(session, guest_user_id) == 1
            finally:
                await session.execute(delete(Game).where(Game.user_id == guest_user_id))
                await session.commit()
