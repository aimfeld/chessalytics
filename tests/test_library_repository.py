"""Integration tests for app.repositories.library_repository (Phase 106-01).

Uses a real PostgreSQL database via the db_session fixture (rolled-back per test).
Covers the Wave-0 seam guards from 106-VALIDATION.md:

- `-k exists_filter` — the user-color-scoped EXISTS severity filter selects games
  with >=1 USER ply of the requested severity, excludes clean games, and EXCLUDES
  a game where only the OPPONENT blundered (B1 guard).
- `-k analyzed_denominator` — placeholder, implemented in 106-03.

Note: The SQL<->kernel cross-check (B2, `TestCrossCheck`) was retired in Phase 108
Plan 03 (D-02 migration). The `game_flaws` table IS the materialized kernel output,
so there is no longer a separate SQL path that could drift from the kernel. The new
invariant is tested in `tests/test_flaw_predicate.py`.

Reuses _seed_game / _seed_position helpers patterned on tests/test_flaws_repository.py.
"""

import datetime
import uuid
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import Subquery, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.game_flaw import GameFlaw
from app.repositories.game_flaws_repository import bulk_insert_game_flaws
from app.repositories.library_repository import (
    TacticOrientation,
    _analyzed_game_ids_subquery,
    analyzed_game_ids,
    count_filtered_and_analyzed,
    fetch_page_game_flaws,
    fetch_stats_aggregates,
    query_filtered_games,
    query_flaws,
)
from app.repositories.query_utils import apply_game_filters

# Distinct user ID for TestDecidedLostSuppression tests so parallel -n auto runs
# cannot cross-contaminate with the 99999/99998 fixtures.
_DL_USER_ID = 99997

# ---------------------------------------------------------------------------
# Seed helpers (mirror tests/test_flaws_repository.py)
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(autouse=True)
async def _create_test_users(db_session: AsyncSession) -> None:
    """Ensure test user IDs exist in the users table (FK constraint)."""
    from tests.conftest import ensure_test_user

    for uid in [99999, 99998, _DL_USER_ID]:
        await ensure_test_user(db_session, uid)


async def _seed_game(
    session: AsyncSession,
    *,
    user_id: int = 99999,
    user_color: str = "white",
    white_blunders: int | None = None,
    platform: str = "lichess",
    full_evals_completed_at: datetime.datetime | None = None,
    lichess_evals_at: datetime.datetime | None = None,
) -> Game:
    """Insert a Game row and flush to obtain an ID.

    white_blunders drives Game.is_analyzed (the cheap analyzed detector): pass a
    non-None value to mark the game as having full move-quality analysis.
    full_evals_completed_at drives the _analyzed_game_ids_subquery gate (replaced the
    old per-ply eval-coverage recompute in quick-task 260617-pu4): pass a non-None
    datetime to mark the game as fully evaluated by the drain.
    """
    game = Game(
        user_id=user_id,
        platform=platform,
        platform_game_id=str(uuid.uuid4()),
        platform_url="https://lichess.org/test",
        pgn="1. e4 e5 *",
        result="1-0",
        user_color=user_color,
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        base_time_seconds=600,
        increment_seconds=0.0,
        rated=True,
        is_computer_game=False,
        white_blunders=white_blunders,
        full_evals_completed_at=full_evals_completed_at,
        lichess_evals_at=lichess_evals_at,
    )
    session.add(game)
    await session.flush()
    return game


async def _seed_position(
    session: AsyncSession,
    *,
    game: Game,
    ply: int,
    eval_cp: int | None = None,
    eval_mate: int | None = None,
    clock_seconds: float | None = None,
    phase: int = 1,
    move_san: str | None = None,
    best_move: str | None = None,
) -> GamePosition:
    """Insert a GamePosition row and flush."""
    pos = GamePosition(
        game_id=game.id,
        user_id=game.user_id,
        ply=ply,
        full_hash=hash(f"{game.id}-{ply}"),
        white_hash=hash(f"w-{game.id}-{ply}"),
        black_hash=hash(f"b-{game.id}-{ply}"),
        move_san=move_san,
        clock_seconds=clock_seconds,
        phase=phase,
        eval_cp=eval_cp,
        eval_mate=eval_mate,
        best_move=best_move,
        endgame_class=None,
    )
    session.add(pos)
    await session.flush()
    return pos


async def _seed_game_flaw(
    session: AsyncSession,
    *,
    game: Game,
    ply: int = 2,
    severity: int = 2,  # 2=blunder (see _SEVERITY_INT in game_flaws_repository)
    allowed_tactic_motif: int | None = None,
    allowed_tactic_confidence: int | None = None,
    allowed_tactic_depth: int | None = None,
    missed_tactic_motif: int | None = None,
    missed_tactic_confidence: int | None = None,
    missed_tactic_depth: int | None = None,
) -> None:
    """Insert a game_flaws row directly (bypasses classifier).

    D-02 migration: EXISTS filter now reads game_flaws rows, not positions.

    Quick 260620-pza: optional tactic-motif columns (raw DB ints) so tests can
    exercise the tactic EXISTS threaded into query_filtered_games. Since SEED-061
    apply_game_filters gates the tactic EXISTS on confidence (>= _TACTIC_CHIP_CONFIDENCE_MIN),
    matching the chip/flaw builders, so callers must set confidence to match.
    """
    await bulk_insert_game_flaws(
        session,
        [
            {
                "user_id": game.user_id,
                "game_id": game.id,
                "ply": ply,
                "severity": severity,
                "tempo": None,
                "phase": 1,  # middlegame
                "is_miss": False,
                "is_lucky": False,
                "is_reversed": False,
                "is_squandered": False,
                "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
                "allowed_tactic_motif": allowed_tactic_motif,
                "allowed_tactic_confidence": allowed_tactic_confidence,
                "allowed_tactic_depth": allowed_tactic_depth,
                "missed_tactic_motif": missed_tactic_motif,
                "missed_tactic_confidence": missed_tactic_confidence,
                "missed_tactic_depth": missed_tactic_depth,
            }
        ],
    )


async def _matching_game_ids(
    session: AsyncSession, *, user_id: int, severities: list[str]
) -> set[int]:
    """Run apply_game_filters with the flaw_severity EXISTS and return matched ids."""
    stmt = select(Game.id).where(Game.user_id == user_id)
    stmt = apply_game_filters(
        stmt,
        time_control=None,
        platform=None,
        rated=None,
        opponent_type="all",
        from_date=None,
        to_date=None,
        flaw_severity=severities,
        user_id=user_id,
    )
    rows = (await session.execute(stmt)).scalars().all()
    return set(rows)


# ---------------------------------------------------------------------------
# TestExistsFilter (-k exists_filter)
# ---------------------------------------------------------------------------


class TestExistsFilter:
    """The user-scoped EXISTS flaw-severity filter reads game_flaws table (D-02)."""

    @pytest.mark.asyncio
    async def test_exists_filter_selects_game_with_flaw_excludes_clean(
        self, db_session: AsyncSession
    ) -> None:
        """A game with a game_flaws blunder row is selected; a clean game is not.

        D-02 migration: the EXISTS filter reads game_flaws directly (not the
        window-scan). The user-scoping is enforced via game_flaws.user_id.
        """
        # Game A: has a game_flaws blunder row.
        game_a = await _seed_game(db_session, user_color="white")
        await _seed_game_flaw(db_session, game=game_a, ply=2, severity=2)  # blunder

        # Game B: no game_flaws rows (clean).
        game_b = await _seed_game(db_session, user_color="white")

        matched = await _matching_game_ids(db_session, user_id=99999, severities=["blunder"])
        assert game_a.id in matched, "game with a blunder flaw row must match severity=blunder"
        assert game_b.id not in matched, "game with no flaw rows must not match"

    @pytest.mark.asyncio
    async def test_exists_filter_user_scoped_excludes_other_users_flaws(
        self, db_session: AsyncSession
    ) -> None:
        """EXISTS is user-scoped: another user's game_flaws rows do not satisfy the filter.

        The game belongs to user 99999; user 99998 has no flaw row for it. The EXISTS
        predicate is always scoped to game_flaws.user_id == the querying user_id (T-108-07).
        """
        game = await _seed_game(db_session, user_id=99999, user_color="white")
        # Seed a blunder row for user 99999 only.
        await _seed_game_flaw(db_session, game=game, ply=2, severity=2)

        # Querying as user 99998 must find no matching games.
        matched = await _matching_game_ids(db_session, user_id=99998, severities=["blunder"])
        assert game.id not in matched, (
            "EXISTS bound to user 99998 must not match game_flaws rows owned by user 99999"
        )

    @pytest.mark.asyncio
    async def test_exists_filter_mistake_matches_only_mistake_not_blunder(
        self, db_session: AsyncSession
    ) -> None:
        """severity=["mistake"] matches games with mistake rows only (set-membership).

        Phase 108 changed severity filtering from a "mistake or worse" MIN threshold to
        exact set-membership: severity=["mistake"] selects mistakes only, NOT blunders.
        """
        # Game A: mistake row (severity=1).
        game_a = await _seed_game(db_session, user_color="white")
        await _seed_game_flaw(db_session, game=game_a, ply=2, severity=1)  # mistake

        # Game B: blunder row (severity=2). Must NOT match ["mistake"] under set-membership.
        game_b = await _seed_game(db_session, user_color="white")
        await _seed_game_flaw(db_session, game=game_b, ply=4, severity=2)  # blunder

        # Game C: no flaw rows.
        game_c = await _seed_game(db_session, user_color="white")

        matched = await _matching_game_ids(db_session, user_id=99999, severities=["mistake"])
        assert game_a.id in matched, "game with a mistake must match severity=mistake"
        assert game_b.id not in matched, "game with only a blunder must NOT match severity=mistake"
        assert game_c.id not in matched, "game with no flaw rows must not match"


# ---------------------------------------------------------------------------
# TestQueryFilteredGames (-k query_filtered_games) — paginated archive (106-02)
# ---------------------------------------------------------------------------


class TestQueryFilteredGames:
    """query_filtered_games: paginated user archive + boolean severity filter."""

    @pytest.mark.asyncio
    async def test_severity_filter_narrows_to_blunder_games(self, db_session: AsyncSession) -> None:
        """severity=["blunder"] returns only games with a game_flaws blunder row (D-02)."""
        # Game A: has a blunder flaw row in game_flaws.
        game_a = await _seed_game(db_session, user_color="white")
        await _seed_game_flaw(db_session, game=game_a, ply=2, severity=2)  # blunder

        # Game B: no flaw rows (clean).
        game_b = await _seed_game(db_session, user_color="white")

        # Unfiltered: both games present.
        all_games, all_count = await query_filtered_games(
            db_session,
            user_id=99999,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=20,
        )
        all_ids = {g.id for g in all_games}
        assert {game_a.id, game_b.id} <= all_ids
        assert all_count >= 2

        # Filtered: only the blunder game.
        flt_games, flt_count = await query_filtered_games(
            db_session,
            user_id=99999,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=["blunder"],
            offset=0,
            limit=20,
        )
        flt_ids = {g.id for g in flt_games}
        assert game_a.id in flt_ids
        assert game_b.id not in flt_ids
        assert flt_count == len(flt_ids)

    @pytest.mark.asyncio
    async def test_tactic_family_filter_narrows_games(self, db_session: AsyncSession) -> None:
        """Quick 260620-pza: tactic_families=["fork"] returns only games with a
        fork-motif flaw (the tactic EXISTS threaded into query_filtered_games)."""
        from app.services.tactic_detector import TacticMotifInt

        user_id = 99999
        # Game A: a blunder carrying an ALLOWED fork motif.
        game_a = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_a,
            ply=2,
            allowed_tactic_motif=int(TacticMotifInt.FORK),
            allowed_tactic_confidence=90,
            allowed_tactic_depth=0,
        )
        # Game B: a blunder with a DIFFERENT motif (skewer) — should be excluded.
        game_b = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_b,
            ply=2,
            allowed_tactic_motif=int(TacticMotifInt.SKEWER),
            allowed_tactic_confidence=90,
            allowed_tactic_depth=0,
        )
        # Game C: a flaw with no tactic motif — should be excluded.
        game_c = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(db_session, game=game_c, ply=2)

        games, count = await query_filtered_games(
            db_session,
            user_id=user_id,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            tactic_families=["fork"],
            offset=0,
            limit=20,
        )
        ids = {g.id for g in games}
        assert game_a.id in ids
        assert game_b.id not in ids
        assert game_c.id not in ids
        assert count == len(ids)

    @pytest.mark.asyncio
    async def test_tactic_orientation_filter_narrows_games(self, db_session: AsyncSession) -> None:
        """Quick 260620-pza: orientation='missed' matches only games whose fork is in
        the MISSED column, not the ALLOWED column."""
        from app.services.tactic_detector import TacticMotifInt

        user_id = 99998
        # Game with an ALLOWED fork only.
        game_allowed = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_allowed,
            ply=2,
            allowed_tactic_motif=int(TacticMotifInt.FORK),
            allowed_tactic_confidence=90,
            allowed_tactic_depth=0,
        )
        # Game with a MISSED fork only.
        game_missed = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_missed,
            ply=2,
            missed_tactic_motif=int(TacticMotifInt.FORK),
            missed_tactic_confidence=90,
            missed_tactic_depth=0,
        )

        games, _ = await query_filtered_games(
            db_session,
            user_id=user_id,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            tactic_families=["fork"],
            tactic_orientation="missed",
            offset=0,
            limit=20,
        )
        ids = {g.id for g in games}
        assert game_missed.id in ids
        assert game_allowed.id not in ids

    @pytest.mark.asyncio
    async def test_depth_filter_narrows_games_without_family(
        self, db_session: AsyncSession
    ) -> None:
        """Quick 260621-sm8 follow-up: a depth range with NO family selected restricts games.

        Regression for the "5130 of 5138 regardless of depth" bug — the Games-tab
        tactic EXISTS was gated on a selected family, so a depth-only filter added
        no row restriction. min/max_tactic_depth=1/2 must now exclude games whose
        only tactic is out of range, and games with no tactic at all.
        """
        from app.services.tactic_detector import TacticMotifInt

        user_id = 99998
        # In range: missed fork at raw depth 1 (anchored 1, in [1, 2]).
        game_in = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_in,
            ply=2,
            missed_tactic_motif=int(TacticMotifInt.FORK),
            missed_tactic_confidence=90,
            missed_tactic_depth=1,
        )
        # Out of range: missed fork at raw depth 10 (anchored 10, outside [1, 2]).
        game_out = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_out,
            ply=2,
            missed_tactic_motif=int(TacticMotifInt.FORK),
            missed_tactic_confidence=90,
            missed_tactic_depth=10,
        )
        # No tactic at all → excluded once a tactic control is active.
        game_none = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(db_session, game=game_none, ply=2)

        games, count = await query_filtered_games(
            db_session,
            user_id=user_id,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            tactic_families=None,  # NO family — depth alone must restrict
            tactic_orientation="either",
            min_tactic_depth=1,
            max_tactic_depth=2,
            offset=0,
            limit=20,
        )
        ids = {g.id for g in games}
        assert game_in.id in ids
        assert game_out.id not in ids
        assert game_none.id not in ids
        assert count == len(ids) == 1

    @pytest.mark.asyncio
    async def test_orientation_filter_narrows_games_without_family(
        self, db_session: AsyncSession
    ) -> None:
        """Quick 260621-sm8 follow-up: orientation alone (no family) restricts games.

        orientation='missed' with no family must return only games that have a
        missed tactic, excluding allowed-only and non-tactic games.
        """
        from app.services.tactic_detector import TacticMotifInt

        user_id = 99998
        game_missed = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_missed,
            ply=2,
            missed_tactic_motif=int(TacticMotifInt.FORK),
            missed_tactic_confidence=90,
            missed_tactic_depth=0,
        )
        game_allowed = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_allowed,
            ply=2,
            allowed_tactic_motif=int(TacticMotifInt.FORK),
            allowed_tactic_confidence=90,
            allowed_tactic_depth=0,
        )
        game_none = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(db_session, game=game_none, ply=2)

        games, count = await query_filtered_games(
            db_session,
            user_id=user_id,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            tactic_families=None,  # NO family — orientation alone must restrict
            tactic_orientation="missed",
            offset=0,
            limit=20,
        )
        ids = {g.id for g in games}
        assert game_missed.id in ids
        assert game_allowed.id not in ids
        assert game_none.id not in ids
        assert count == len(ids) == 1

    @pytest.mark.asyncio
    async def test_default_filter_returns_all_games(self, db_session: AsyncSession) -> None:
        """Quick 260621-sm8 follow-up: default tactic state adds NO row restriction.

        With no family, orientation='either', and the full depth range, non-tactic
        games must still appear (regression guard that the EXISTS gate stays off at
        the default — i.e. _tactic_controls_active is False).
        """
        user_id = 99998
        game_tactic = await _seed_game(db_session, user_id=user_id, user_color="white")
        from app.services.tactic_detector import TacticMotifInt

        await _seed_game_flaw(
            db_session,
            game=game_tactic,
            ply=2,
            missed_tactic_motif=int(TacticMotifInt.FORK),
            missed_tactic_confidence=90,
            missed_tactic_depth=5,
        )
        game_none = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(db_session, game=game_none, ply=2)

        games, count = await query_filtered_games(
            db_session,
            user_id=user_id,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            tactic_families=None,
            tactic_orientation="either",
            min_tactic_depth=0,  # full range (DEPTH_MIN)
            max_tactic_depth=11,  # full range (DEPTH_MAX)
            offset=0,
            limit=20,
        )
        ids = {g.id for g in games}
        assert game_tactic.id in ids
        assert game_none.id in ids, "non-tactic game must appear at the default filter"
        assert count == len(ids) == 2

    @pytest.mark.asyncio
    async def test_tactic_filter_excludes_opponent_only_tactic(
        self, db_session: AsyncSession
    ) -> None:
        """SEED-060: the Games-tab tactic filter must NOT flag a game whose only
        family-X tactic belongs to the OPPONENT.

        Since Phase 113, game_flaws holds both sides' flaws (player attributed via
        ply parity vs user_color). For a white user, an ODD ply is the black mover =
        opponent. A game with only an opponent fork must be excluded by the
        player_only_gate, mirroring flaw_exists_from_table's behavior.
        """
        from app.services.tactic_detector import TacticMotifInt

        user_id = 99998
        # Game P: PLAYER fork (white user, even ply 2 = white mover = player) — included.
        game_player = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_player,
            ply=2,
            allowed_tactic_motif=int(TacticMotifInt.FORK),
            allowed_tactic_confidence=90,
            allowed_tactic_depth=0,
        )
        # Game O: OPPONENT-only fork (white user, odd ply 3 = black mover = opponent) — excluded.
        game_opponent = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_opponent,
            ply=3,
            allowed_tactic_motif=int(TacticMotifInt.FORK),
            allowed_tactic_confidence=90,
            allowed_tactic_depth=0,
        )

        games, _ = await query_filtered_games(
            db_session,
            user_id=user_id,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            tactic_families=["fork"],
            offset=0,
            limit=20,
        )
        ids = {g.id for g in games}
        assert game_player.id in ids, "player's own fork must match the tactic filter"
        assert game_opponent.id not in ids, (
            "opponent-only fork must NOT flag the game (player_only_gate)"
        )

    @pytest.mark.asyncio
    async def test_tactic_filter_excludes_below_confidence_tactic(
        self, db_session: AsyncSession
    ) -> None:
        """SEED-061: the Games-tab tactic filter must NOT flag a game whose only
        family-X tactic is below the chip-display confidence threshold (70).

        Chip display is gated at _TACTIC_CHIP_CONFIDENCE_MIN, so a game matched on a
        sub-threshold fork would show no fork chip — a visible inconsistency. The
        filter now gates on confidence to match build_flaw_filter_clauses.
        """
        from app.repositories.library_repository import _TACTIC_CHIP_CONFIDENCE_MIN
        from app.services.tactic_detector import TacticMotifInt

        user_id = 99999
        # Game H: HIGH-confidence fork (>= threshold) — included.
        game_high = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_high,
            ply=2,
            allowed_tactic_motif=int(TacticMotifInt.FORK),
            allowed_tactic_confidence=_TACTIC_CHIP_CONFIDENCE_MIN,
            allowed_tactic_depth=0,
        )
        # Game L: LOW-confidence fork (below threshold) — excluded.
        game_low = await _seed_game(db_session, user_id=user_id, user_color="white")
        await _seed_game_flaw(
            db_session,
            game=game_low,
            ply=2,
            allowed_tactic_motif=int(TacticMotifInt.FORK),
            allowed_tactic_confidence=_TACTIC_CHIP_CONFIDENCE_MIN - 1,
            allowed_tactic_depth=0,
        )

        games, _ = await query_filtered_games(
            db_session,
            user_id=user_id,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            tactic_families=["fork"],
            offset=0,
            limit=20,
        )
        ids = {g.id for g in games}
        assert game_high.id in ids, "fork at the chip-display threshold must match"
        assert game_low.id not in ids, "sub-threshold fork must NOT flag the game (confidence gate)"

    @pytest.mark.asyncio
    async def test_pagination_and_matched_count(self, db_session: AsyncSession) -> None:
        """matched_count reflects all matching games; offset/limit page the result."""
        seeded: set[int] = set()
        for _ in range(3):
            g = await _seed_game(db_session, user_id=99998, user_color="white")
            await _seed_position(db_session, game=g, ply=0, eval_cp=0)
            seeded.add(g.id)

        page1, count = await query_filtered_games(
            db_session,
            user_id=99998,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=2,
        )
        assert count >= 3
        assert len(page1) == 2

        page2, _ = await query_filtered_games(
            db_session,
            user_id=99998,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=2,
            limit=2,
        )
        page1_ids = {g.id for g in page1}
        page2_ids = {g.id for g in page2}
        assert page1_ids.isdisjoint(page2_ids)
        assert seeded <= (page1_ids | page2_ids | {g.id for g in page1})

    @pytest.mark.asyncio
    async def test_empty_returns_zero(self, db_session: AsyncSession) -> None:
        """A user with no games returns ([], 0)."""
        games, count = await query_filtered_games(
            db_session,
            user_id=99998,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=["blunder"],
            offset=0,
            limit=20,
        )
        assert games == []
        assert count == 0


# ---------------------------------------------------------------------------
# TestAnalyzedDenominator (-k analyzed_denominator) — the >=90% coverage gate
# ---------------------------------------------------------------------------


class TestAnalyzedDenominator:
    """count_filtered_and_analyzed + analyzed_game_ids over the filtered set."""

    @pytest.mark.asyncio
    async def test_analyzed_denominator_counts_only_covered_games(
        self, db_session: AsyncSession
    ) -> None:
        """One analyzed game + one unanalyzed game: total_n==2, analyzed_n==1.

        count_filtered_and_analyzed and analyzed_game_ids both key analyzed_n off
        the authoritative full_evals_completed_at column (via
        _analyzed_game_ids_subquery). The seeded "analyzed" game carries
        move-quality counts AND full_evals_completed_at, mirroring a real Lichess
        game with the Stockfish eval drain completed.
        """
        # Analyzed game: move-quality counts (is_analyzed) AND full_evals_completed_at set.
        _now = datetime.datetime.now(tz=datetime.timezone.utc)
        analyzed = await _seed_game(
            db_session,
            user_id=99999,
            user_color="white",
            white_blunders=1,
            full_evals_completed_at=_now,
        )

        # chess.com-style game: no move-quality counts, full_evals_completed_at NULL -> NOT analyzed.
        chesscom = await _seed_game(db_session, user_id=99999, user_color="white")

        total_n, analyzed_n = await count_filtered_and_analyzed(
            db_session,
            user_id=99999,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
        )
        assert total_n == 2, "both games are in the filtered set"
        assert analyzed_n == 1, "only the game with move-quality analysis counts"

        ids = await analyzed_game_ids(
            db_session,
            user_id=99999,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert analyzed.id in ids
        assert chesscom.id not in ids

    @pytest.mark.asyncio
    async def test_short_fully_analyzed_game_is_analyzed(self, db_session: AsyncSession) -> None:
        """Regression (260615-rb1 / 260617-pu4): a short fully-analyzed game is counted.

        The old per-ply coverage recompute excluded short games: 7 movable plies /
        (COUNT(*)-1 = 7) = 1.0 passes, but the predecessor bug (COUNT(*) = 8 denominator)
        gave 7/8 = 0.875 < 0.90. Both are superseded: the gate is now the authoritative
        games.full_evals_completed_at column (quick-task 260617-pu4), set by the eval
        drain only when the kernel is satisfied. A game with full_evals_completed_at IS
        NOT NULL is analyzed regardless of raw position counts or ply length.
        """
        _now = datetime.datetime.now(tz=datetime.timezone.utc)
        short = await _seed_game(
            db_session,
            user_id=99999,
            user_color="white",
            white_blunders=0,
            full_evals_completed_at=_now,
        )

        ids = await analyzed_game_ids(
            db_session,
            user_id=99999,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert short.id in ids, (
            "short fully-analyzed game must pass the full_evals_completed_at gate"
        )

    @pytest.mark.asyncio
    async def test_tactic_filter_orientation_either_includes_missed_only_game(
        self, db_session: AsyncSession
    ) -> None:
        """SEED-062: the tactic-comparison gate narrows the population on "either".

        A game whose only fork is in the MISSED column must be in the population when
        the gate uses tactic_filter_orientation="either" (the basis the dual-orientation
        comparison grid renders over), but is excluded under the legacy "allowed"
        default. This keeps the gate's analyzed_n and the per-orientation bullet
        populations on one shared basis.
        """
        from app.services.tactic_detector import TacticMotifInt

        user_id = 99999
        _now = datetime.datetime.now(tz=datetime.timezone.utc)
        # Analyzed game with a MISSED-only fork (white user, even ply 2 = player).
        game = await _seed_game(
            db_session,
            user_id=user_id,
            user_color="white",
            white_blunders=1,
            full_evals_completed_at=_now,
        )
        await _seed_game_flaw(
            db_session,
            game=game,
            ply=2,
            missed_tactic_motif=int(TacticMotifInt.FORK),
            missed_tactic_confidence=90,
            missed_tactic_depth=0,
        )

        # Explicit dict[str, Any] so the **spread satisfies each typed keyword param;
        # an inferred union value type makes ty reject the spread (invalid-argument-type).
        _kwargs: dict[str, Any] = dict(
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            tactic_families=["fork"],
        )

        # "allowed" default: missed-only fork is NOT in the allowed column → excluded.
        _total_allowed, analyzed_allowed = await count_filtered_and_analyzed(
            db_session, user_id=user_id, tactic_filter_orientation="allowed", **_kwargs
        )
        assert analyzed_allowed == 0, "missed-only fork must not match the allowed-column basis"

        # "either" basis (the comparison endpoint): missed-only fork is included.
        _total_either, analyzed_either = await count_filtered_and_analyzed(
            db_session, user_id=user_id, tactic_filter_orientation="either", **_kwargs
        )
        assert analyzed_either == 1, "missed-only fork must match the either-column basis"

    @pytest.mark.asyncio
    async def test_total_n_spans_all_platforms(self, db_session: AsyncSession) -> None:
        """total_n counts chess.com games too; only the analyzed lichess game is analyzed_n.

        Regression: the coverage badge denominator must NOT be platform- or
        flaw-restricted. An unanalyzed chess.com game (full_evals_completed_at
        NULL) is in total_n but not analyzed_n, so the badge reads "1 of 2", not
        "1 of 1".
        """
        _now = datetime.datetime.now(tz=datetime.timezone.utc)
        lichess = await _seed_game(
            db_session,
            user_id=99999,
            platform="lichess",
            white_blunders=0,
            full_evals_completed_at=_now,
        )
        await _seed_position(db_session, game=lichess, ply=0, eval_cp=0)
        chesscom = await _seed_game(db_session, user_id=99999, platform="chess.com")
        await _seed_position(db_session, game=chesscom, ply=0, eval_cp=None)

        total_n, analyzed_n = await count_filtered_and_analyzed(
            db_session,
            user_id=99999,
            time_control=None,
            platform=None,  # no platform filter -> both platforms counted
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
        )
        assert total_n == 2, "chess.com game must be counted in the denominator"
        assert analyzed_n == 1, "only the analyzed lichess game counts as analyzed"

    @pytest.mark.asyncio
    async def test_analyzed_n_matches_full_evals_not_is_analyzed(
        self, db_session: AsyncSession
    ) -> None:
        """Regression (badge mismatch): analyzed_n keys off full_evals_completed_at.

        analyzed_n used to be Game.is_analyzed (white_blunders IS NOT NULL), which
        diverged from _analyzed_game_ids_subquery in BOTH directions. That made the
        Stats-tab badge disagree with the Games/Flaws badges, and — worse — put the
        get_flaw_stats rate denominator on a different population than the numerators
        (which join analyzed_subq). Both edge cases are pinned here:

        - lichess freebie: white_blunders set at IMPORT, our drain never ran
          (full_evals_completed_at NULL) -> NOT analyzed.
        - degenerate game: drain stamped full_evals_completed_at but wrote no
          move-quality columns -> analyzed (its card shows no "Analyze" button).
        """
        _now = datetime.datetime.now(tz=datetime.timezone.utc)
        # Lichess %eval freebie — is_analyzed would wrongly count this.
        await _seed_game(db_session, user_id=99999, platform="lichess", white_blunders=2)
        # Degenerate drain-stamped game — is_analyzed would wrongly skip this.
        await _seed_game(
            db_session,
            user_id=99999,
            platform="chess.com",
            full_evals_completed_at=_now,
        )

        total_n, analyzed_n = await count_filtered_and_analyzed(
            db_session,
            user_id=99999,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
        )
        assert total_n == 2
        assert analyzed_n == 1, (
            "only the full_evals_completed_at game counts; white_blunders alone does not"
        )

    @pytest.mark.asyncio
    async def test_analyzed_denominator_user_scoped(self, db_session: AsyncSession) -> None:
        """A different user's analyzed game is not counted/listed."""
        game = await _seed_game(db_session, user_id=99999, user_color="white")
        for ply in range(9):
            await _seed_position(db_session, game=game, ply=ply, eval_cp=0)
        await _seed_position(db_session, game=game, ply=9, eval_cp=None)

        total_n, analyzed_n = await count_filtered_and_analyzed(
            db_session,
            user_id=99998,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
        )
        assert total_n == 0
        assert analyzed_n == 0
        ids = await analyzed_game_ids(
            db_session,
            user_id=99998,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert ids == []


# ---------------------------------------------------------------------------
# Shared flaw-row helper for player-only gate tests
# ---------------------------------------------------------------------------

_SEV_MISTAKE = 1
_SEV_BLUNDER = 2


def _flaw_row(
    *,
    user_id: int,
    game_id: int,
    ply: int,
    severity: int = _SEV_BLUNDER,
) -> dict:  # type: ignore[type-arg]
    """Return a game_flaws insert dict with sensible defaults."""
    return {
        "user_id": user_id,
        "game_id": game_id,
        "ply": ply,
        "severity": severity,
        "tempo": None,
        "phase": 1,  # middlegame
        "is_miss": False,
        "is_lucky": False,
        "is_reversed": False,
        "is_squandered": False,
        "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
    }


# ---------------------------------------------------------------------------
# TestPlayerOnlyGate — D-04 player-only gate on query_flaws (R2)
# ---------------------------------------------------------------------------


class TestPlayerOnlyGate:
    """query_flaws returns only player flaws after both-sides materialization (D-04, R2).

    After Phase 113 Plan 01, game_flaws contains rows for BOTH the player and
    the opponent. query_flaws is the Flaws-subtab list reader; it must return
    only the player's flaws so opponent blunders do not appear as flaw cards.

    Parity convention (is_opponent_expr — query_utils.py):
        even ply → white mover → player row iff user_color == 'white'
        odd ply  → black mover → player row iff user_color == 'black'
    """

    @pytest.mark.asyncio
    async def test_query_flaws_excludes_opponent_rows_white_user(
        self, db_session: AsyncSession
    ) -> None:
        """Opponent flaw (odd ply, white user) is excluded from query_flaws results.

        White user → odd ply = black mover = opponent. The player-only gate
        must drop this row from the Flaws-subtab list and from matched_count.
        """
        game = await _seed_game(db_session, user_id=99999, user_color="white")
        # Opponent flaw (odd ply, white user → black mover → opponent)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=1)])
        # Player flaw (even ply, white user → white mover → player)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=2)])

        items, count = await query_flaws(
            db_session,
            user_id=99999,
            severity=["blunder"],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=20,
        )
        plies = [item.ply for item in items]
        assert 1 not in plies, (
            "opponent flaw at ply=1 (odd, white user) must be excluded from query_flaws"
        )
        assert 2 in plies, "player flaw at ply=2 (even, white user) must be present"
        assert count == 1, "matched_count must reflect only the player flaw (D-04)"

    @pytest.mark.asyncio
    async def test_query_flaws_excludes_opponent_rows_black_user(
        self, db_session: AsyncSession
    ) -> None:
        """Opponent flaw (even ply, black user) is excluded from query_flaws results.

        Black user → even ply = white mover = opponent.
        """
        game = await _seed_game(db_session, user_id=99999, user_color="black")
        # Opponent flaw (even ply, black user → white mover → opponent)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=2)])
        # Player flaw (odd ply, black user → black mover → player)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=1)])

        items, count = await query_flaws(
            db_session,
            user_id=99999,
            severity=["blunder"],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=20,
        )
        plies = [item.ply for item in items]
        assert 2 not in plies, (
            "opponent flaw at ply=2 (even, black user) must be excluded from query_flaws"
        )
        assert 1 in plies, "player flaw at ply=1 (odd, black user) must be present"
        assert count == 1, "matched_count must reflect only the player flaw (D-04)"


# ---------------------------------------------------------------------------
# TestPageFlawsPlayerOnly — D-04 player-only gate on fetch_page_game_flaws (R3)
# ---------------------------------------------------------------------------


class TestPageFlawsPlayerOnly:
    """fetch_page_game_flaws returns only player GameFlaw rows per game (D-04, R3).

    After Phase 113 Plan 01, game_flaws contains rows for BOTH the player and
    the opponent. fetch_page_game_flaws feeds chip/M+B building on the Games-tab
    cards; it must return only player rows so chips and counts are accurate.
    """

    @pytest.mark.asyncio
    async def test_page_flaws_excludes_opponent_rows_white_user(
        self, db_session: AsyncSession
    ) -> None:
        """Opponent flaw (odd ply, white user) excluded from per-game flaw dict.

        White user → odd ply = black mover = opponent.
        """
        game = await _seed_game(db_session, user_id=99999, user_color="white")
        # Opponent flaw (odd ply, white user → black mover → opponent)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=1)])
        # Player flaw (even ply, white user → white mover → player)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=2)])

        result = await fetch_page_game_flaws(db_session, 99999, [game.id])
        game_flaws = result[game.id]
        plies = [f.ply for f in game_flaws]
        assert 1 not in plies, (
            "opponent flaw at ply=1 (odd, white user) must be excluded from "
            "fetch_page_game_flaws result (D-04, R3)"
        )
        assert 2 in plies, "player flaw at ply=2 (even, white user) must be present"
        assert len(game_flaws) == 1, "only the player flaw must appear in the page result"

    @pytest.mark.asyncio
    async def test_page_flaws_excludes_opponent_rows_black_user(
        self, db_session: AsyncSession
    ) -> None:
        """Opponent flaw (even ply, black user) excluded from per-game flaw dict.

        Black user → even ply = white mover = opponent.
        """
        game = await _seed_game(db_session, user_id=99999, user_color="black")
        # Opponent flaw (even ply, black user → white mover → opponent)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=2)])
        # Player flaw (odd ply, black user → black mover → player)
        await bulk_insert_game_flaws(db_session, [_flaw_row(user_id=99999, game_id=game.id, ply=1)])

        result = await fetch_page_game_flaws(db_session, 99999, [game.id])
        game_flaws = result[game.id]
        plies = [f.ply for f in game_flaws]
        assert 2 not in plies, (
            "opponent flaw at ply=2 (even, black user) must be excluded from "
            "fetch_page_game_flaws result (D-04, R3)"
        )
        assert 1 in plies, "player flaw at ply=1 (odd, black user) must be present"
        assert len(game_flaws) == 1, "only the player flaw must appear in the page result"


# Keep `func` import referenced (used by downstream count-aggregate scaffolds).
_ = func


# ---------------------------------------------------------------------------
# TestEvalJoin (Phase 112-01): regression guard + schema check
# ---------------------------------------------------------------------------


async def _seed_game_flaw_with_es(
    session: AsyncSession,
    *,
    game: Game,
    ply: int,
    severity: int = 2,
    fen: str = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
) -> None:
    """Insert a game_flaws row for eval-join regression tests.

    Phase 112 (D-07): es_before/es_after/move_san are no longer stored in game_flaws;
    they are sourced at query time via a game_positions join. The test verifies that
    the join reproduces the correct eval values from the seeded game_positions rows.
    """
    await bulk_insert_game_flaws(
        session,
        [
            {
                "user_id": game.user_id,
                "game_id": game.id,
                "ply": ply,
                "severity": severity,
                "tempo": None,
                "phase": 1,  # middlegame
                "is_miss": False,
                "is_lucky": False,
                "is_reversed": False,
                "is_squandered": False,
                "fen": fen,
            }
        ],
    )


class TestEvalJoinReproducesEs:
    """Phase 112 Pitfall 1 regression guard: game_positions join has correct ply offset.

    Verifies that the two aliased LEFT JOINs on game_positions (PositionAt at ply=N,
    PositionBefore at ply=N-1) return the eval values the kernel uses for es_before/es_after.
    If the ply offset is wrong, the ES computed from the join will differ from the seed-computed ES.
    """

    @pytest.mark.asyncio
    async def test_eval_join_reproduces_es(self, db_session: AsyncSession) -> None:
        """Joined eval_cp reproduces the ES values the kernel would compute.

        Seed: flaw at ply=2 (white mover per kernel parity: even=white).
          - positions[1].eval_cp = +100  (eval_before in flaws_service terms: positions[N-1])
          - positions[2].eval_cp = -50   (eval_after: positions[N])
        ES values computed directly from seeded evals (Phase 112: no longer stored):
          - es_before = eval_cp_to_expected_score(+100, "white") ≈ 0.591
          - es_after  = eval_cp_to_expected_score(-50, "white")  ≈ 0.454
        The test asserts abs(computed_from_join - computed_from_seed) < 1e-6 for both.
        """
        from app.repositories.library_repository import query_flaws
        from app.services.eval_utils import eval_cp_to_expected_score

        game = await _seed_game(db_session, user_color="white")
        # Seed positions 0..3 (ply 0=initial, 1=black, 2=white mover flaw, 3=next)
        # Kernel parity: n % 2 == 0 → white mover. Flaw at ply=2 → white.
        await _seed_position(db_session, game=game, ply=0, eval_cp=0, move_san=None)
        await _seed_position(db_session, game=game, ply=1, eval_cp=100, move_san="e5")
        # ply=2: white mover; eval_before = positions[1].eval_cp = 100; eval_after = positions[2].eval_cp = -50
        await _seed_position(db_session, game=game, ply=2, eval_cp=-50, move_san="Nf3")
        await _seed_position(db_session, game=game, ply=3, eval_cp=-30, move_san="d5")

        # Compute expected ES values using the same kernel formula
        mover_color = "white"  # ply=2, even → white
        expected_es_before = eval_cp_to_expected_score(100, mover_color)
        expected_es_after = eval_cp_to_expected_score(-50, mover_color)

        # Seed the flaw row with the kernel-computed ES values
        await _seed_game_flaw_with_es(
            db_session,
            game=game,
            ply=2,
            severity=2,  # blunder
        )

        # Run query_flaws and check the join produces the right eval fields
        items, count = await query_flaws(
            db_session,
            user_id=99999,
            severity=["mistake", "blunder"],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=20,
        )
        assert count > 0, "expected at least one flaw row"

        # Find the flaw for our seeded game
        our_flaw = next((item for item in items if item.game_id == game.id and item.ply == 2), None)
        assert our_flaw is not None, "flaw at ply=2 must appear in results"

        # Verify eval fields are sourced from game_positions
        assert our_flaw.eval_cp_after == -50, (
            f"eval_cp_after must be -50 (positions[ply=2].eval_cp), got {our_flaw.eval_cp_after}"
        )
        assert our_flaw.eval_cp_before == 100, (
            f"eval_cp_before must be 100 (positions[ply=1].eval_cp), got {our_flaw.eval_cp_before}"
        )
        assert our_flaw.move_san == "Nf3", f"move_san must be 'Nf3', got {our_flaw.move_san}"

        # ES reproduction: convert joined eval to ES and compare with seed-computed values
        # Mover is white (ply=2, even): no negation needed
        computed_es_before = eval_cp_to_expected_score(our_flaw.eval_cp_before, mover_color)
        computed_es_after = eval_cp_to_expected_score(our_flaw.eval_cp_after, mover_color)

        assert abs(computed_es_before - expected_es_before) < 1e-6, (
            f"Computed es_before {computed_es_before} must match stored {expected_es_before}"
        )
        assert abs(computed_es_after - expected_es_after) < 1e-6, (
            f"Computed es_after {computed_es_after} must match stored {expected_es_after}"
        )

    @pytest.mark.asyncio
    async def test_eval_join_reproduces_es_with_mate(self, db_session: AsyncSession) -> None:
        """Mate rows: eval_mate maps to ±MATE_CP_EQUIVALENT before sigmoid.

        Flaw at ply=3 (black mover, odd ply).
        positions[2].eval_mate = +3 → white has mate-in-3 → black is losing.
        eval_before for black mover = eval_cp_to_expected_score(-MATE_CP_EQUIVALENT, "black")
        """
        from app.repositories.library_repository import query_flaws
        from app.services.eval_utils import eval_cp_to_expected_score
        from app.services.flaws_service import MATE_CP_EQUIVALENT

        game = await _seed_game(db_session, user_color="black")
        await _seed_position(db_session, game=game, ply=0, eval_cp=0, move_san=None)
        await _seed_position(db_session, game=game, ply=1, eval_cp=50, move_san="e4")
        await _seed_position(db_session, game=game, ply=2, eval_mate=3, move_san="e5")
        # ply=3: black mover flaw (odd ply → black); eval_before = positions[2].eval_mate = +3
        await _seed_position(db_session, game=game, ply=3, eval_cp=-400, move_san="Nf6")

        # Kernel: ply=3, n=3, n%2==1 → black mover
        mover_color = "black"
        # es_before: positions[2].eval_mate=+3 (white has mate) → cp_equiv = -MATE_CP_EQUIVALENT for black
        # eval_cp_to_expected_score uses white-POV: +MATE_CP_EQUIVALENT → white winning
        # From black's perspective: -MATE_CP_EQUIVALENT passed as eval_cp
        # Actually _ply_to_es: eval_mate > 0 → cp_equiv = +MATE_CP_EQUIVALENT, then eval_cp_to_expected_score(+MATE_CP_EQ, "black")
        cp_equiv_before = MATE_CP_EQUIVALENT  # eval_mate=+3>0 → +MATE_CP_EQUIVALENT
        expected_es_before = eval_cp_to_expected_score(cp_equiv_before, mover_color)
        expected_es_after = eval_cp_to_expected_score(-400, mover_color)

        await _seed_game_flaw_with_es(
            db_session,
            game=game,
            ply=3,
            severity=2,
        )

        items, count = await query_flaws(
            db_session,
            user_id=99999,
            severity=["mistake", "blunder"],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=20,
        )

        our_flaw = next((item for item in items if item.game_id == game.id and item.ply == 3), None)
        assert our_flaw is not None, "flaw at ply=3 must appear in results"
        assert our_flaw.eval_mate_before == 3, (
            f"eval_mate_before must be 3 (positions[ply=2].eval_mate), got {our_flaw.eval_mate_before}"
        )
        assert our_flaw.eval_cp_after == -400, (
            f"eval_cp_after must be -400, got {our_flaw.eval_cp_after}"
        )

        # ES reproduction with mate: use MATE_CP_EQUIVALENT
        cp_before = MATE_CP_EQUIVALENT  # eval_mate_before=3 > 0 → +MATE_CP_EQUIVALENT
        computed_es_before = eval_cp_to_expected_score(cp_before, mover_color)
        # eval_cp_after is asserted non-None above; assert for ty narrowing
        assert our_flaw.eval_cp_after is not None
        computed_es_after = eval_cp_to_expected_score(our_flaw.eval_cp_after, mover_color)

        assert abs(computed_es_before - expected_es_before) < 1e-6, (
            f"Mate es_before {computed_es_before} must match stored {expected_es_before}"
        )
        assert abs(computed_es_after - expected_es_after) < 1e-6, (
            f"Mate es_after {computed_es_after} must match stored {expected_es_after}"
        )

    @pytest.mark.asyncio
    async def test_eval_join_null_before_at_ply_1(self, db_session: AsyncSession) -> None:
        """A flaw at ply=1 with no ply=0 eval yields eval_cp_before=None (no crash).

        ply=0 (initial position) usually has eval_cp=None; the LEFT JOIN produces null.
        """
        from app.repositories.library_repository import query_flaws

        game = await _seed_game(db_session, user_color="black")
        # ply=0: no eval (typical initial position)
        await _seed_position(db_session, game=game, ply=0, eval_cp=None, move_san=None)
        # ply=1: black's first move; flaw at ply=1
        await _seed_position(db_session, game=game, ply=1, eval_cp=50, move_san="e4")

        await _seed_game_flaw_with_es(db_session, game=game, ply=1, severity=2)

        items, count = await query_flaws(
            db_session,
            user_id=99999,
            severity=["mistake", "blunder"],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=20,
        )

        our_flaw = next((item for item in items if item.game_id == game.id and item.ply == 1), None)
        assert our_flaw is not None, "flaw at ply=1 must appear"
        # ply=0 has eval_cp=None, LEFT JOIN on ply=0 returns a row but eval_cp=None
        # Actually ply=0 HAS a game_positions row (just eval_cp=None), so the join finds the row
        # but eval_cp_before = None (the eval_cp on that row is None)
        assert our_flaw.eval_cp_before is None, (
            f"ply=0 has null eval_cp, so eval_cp_before must be None, got {our_flaw.eval_cp_before}"
        )
        assert our_flaw.eval_cp_after == 50


class TestFlawsEndpointSchema:
    """Phase 112-01 Task 2: FlawListItem carries new fields, drops ES fields."""

    @pytest.mark.asyncio
    async def test_flaws_endpoint_schema(self, db_session: AsyncSession) -> None:
        """FlawListItem carries white_rating/black_rating, move_san, eval fields; no es_before/es_after."""
        from app.repositories.library_repository import query_flaws

        game = await _seed_game(db_session, user_color="white")
        # Seed positions for the flaw
        await _seed_position(db_session, game=game, ply=0, eval_cp=0, move_san=None)
        await _seed_position(db_session, game=game, ply=1, eval_cp=150, move_san="d4")
        # best_move at ply=2 (the flaw's pre-move position) is the engine's
        # recommended move FROM the decision point — surfaced as FlawListItem.best_move.
        await _seed_position(
            db_session, game=game, ply=2, eval_cp=-100, move_san="Nf3", best_move="e2e4"
        )

        await bulk_insert_game_flaws(
            db_session,
            [
                {
                    "user_id": game.user_id,
                    "game_id": game.id,
                    "ply": 2,
                    "severity": 2,
                    "tempo": None,
                    "phase": 1,
                    "is_miss": False,
                    "is_lucky": False,
                    "is_reversed": False,
                    "is_squandered": False,
                    "fen": "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR",
                }
            ],
        )

        items, count = await query_flaws(
            db_session,
            user_id=99999,
            severity=["mistake", "blunder"],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=20,
        )

        our_flaw = next((item for item in items if item.game_id == game.id and item.ply == 2), None)
        assert our_flaw is not None, "flaw at ply=2 must appear"

        # Schema assertions: new fields present
        assert our_flaw.move_san is not None, "move_san must be join-sourced and non-None"
        assert our_flaw.eval_cp_after is not None, "eval_cp_after must be set from game_positions"
        assert our_flaw.eval_cp_before is not None, "eval_cp_before must be set from game_positions"
        # best_move surfaces from the PositionAt (ply=N) join (quick-260618-oqw).
        assert our_flaw.best_move == "e2e4", "best_move must come from game_positions at ply=N"

        # Ratings (sourced from Game; Game was seeded without explicit ratings → None is valid)
        # Check the attribute exists on the model
        assert hasattr(our_flaw, "white_rating"), "FlawListItem must have white_rating field"
        assert hasattr(our_flaw, "black_rating"), "FlawListItem must have black_rating field"
        assert hasattr(our_flaw, "eval_cp_before"), "FlawListItem must have eval_cp_before"
        assert hasattr(our_flaw, "eval_cp_after"), "FlawListItem must have eval_cp_after"
        assert hasattr(our_flaw, "eval_mate_before"), "FlawListItem must have eval_mate_before"
        assert hasattr(our_flaw, "eval_mate_after"), "FlawListItem must have eval_mate_after"

        # Schema assertions: ES fields must NOT be present (dropped in Task 2)
        assert not hasattr(our_flaw, "es_before"), "FlawListItem must NOT have es_before"
        assert not hasattr(our_flaw, "es_after"), "FlawListItem must NOT have es_after"


# ---------------------------------------------------------------------------
# TestStatsAggregatesPlayerOnly — D-04 no-regression baseline for R4/R5
# ---------------------------------------------------------------------------


class TestStatsAggregatesPlayerOnly:
    """fetch_stats_aggregates gated to player-only (D-04, R4).

    The no-regression invariant (highest-risk D-04 invariant, RESEARCH Pitfall 5):
        gated counts == pre-phase player-only baseline
        ungated count > baseline (opponent rows present)

    Both white-user and black-user parity branches are exercised.
    """

    async def _make_analyzed_subq(self, session: AsyncSession, user_id: int) -> Subquery:
        """Return the analyzed_game_ids subquery for use in fetch_stats_aggregates/trend."""
        return _analyzed_game_ids_subquery(user_id)

    async def _seed_analyzed_game_with_positions(
        self,
        session: AsyncSession,
        *,
        user_id: int,
        user_color: str,
    ) -> Game:
        """Seed a game that passes the full_evals_completed_at analyzed gate."""
        _now = datetime.datetime.now(tz=datetime.timezone.utc)
        return await _seed_game(
            session, user_id=user_id, user_color=user_color, full_evals_completed_at=_now
        )

    @pytest.mark.asyncio
    async def test_stats_aggregates_gated_equals_player_only_baseline(
        self, db_session: AsyncSession
    ) -> None:
        """gated fetch_stats_aggregates == player-only baseline; ungated > baseline.

        Sets up two games (white user + black user), inserts player-only flaws first
        (the pre-phase baseline), records the aggregate counts, then inserts opponent
        flaws (both-sides materialized). The gated aggregate must equal the baseline;
        a direct ungated count must be strictly larger (opponent rows present).

        Exercises both parity branches per RESEARCH Pitfall 5 and the D-04 invariant.
        """
        # White user game: player rows at even plies, opponent at odd plies
        game_white = await self._seed_analyzed_game_with_positions(
            db_session, user_id=99999, user_color="white"
        )
        # Black user game: player rows at odd plies, opponent at even plies
        game_black = await self._seed_analyzed_game_with_positions(
            db_session, user_id=99999, user_color="black"
        )

        # --- BASELINE: insert player-only flaws ---
        # White user: player = even ply (2, 4)
        await bulk_insert_game_flaws(
            db_session,
            [
                _flaw_row(user_id=99999, game_id=game_white.id, ply=2, severity=_SEV_BLUNDER),
                _flaw_row(user_id=99999, game_id=game_white.id, ply=4, severity=_SEV_MISTAKE),
            ],
        )
        # Black user: player = odd ply (1, 3)
        await bulk_insert_game_flaws(
            db_session,
            [
                _flaw_row(user_id=99999, game_id=game_black.id, ply=1, severity=_SEV_BLUNDER),
                _flaw_row(user_id=99999, game_id=game_black.id, ply=3, severity=_SEV_MISTAKE),
            ],
        )

        analyzed_subq = await self._make_analyzed_subq(db_session, user_id=99999)

        # Capture baseline (player-only rows → this is the pre-phase state)
        baseline = await fetch_stats_aggregates(
            db_session,
            user_id=99999,
            analyzed_game_ids_subq=analyzed_subq,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            opponent_gap_min=None,
            opponent_gap_max=None,
            color=None,
        )
        baseline_mistake = baseline[0]
        baseline_blunder = baseline[1]
        baseline_total = baseline_mistake + baseline_blunder
        assert baseline_total == 4, (
            "baseline must reflect exactly 4 player flaws (2 per game, 2 games)"
        )

        # --- BOTH-SIDES: add opponent flaws (simulates Phase 113 kernel generalization) ---
        # White user: opponent = odd ply (1, 3)
        await bulk_insert_game_flaws(
            db_session,
            [
                _flaw_row(user_id=99999, game_id=game_white.id, ply=1, severity=_SEV_BLUNDER),
                _flaw_row(user_id=99999, game_id=game_white.id, ply=3, severity=_SEV_BLUNDER),
            ],
        )
        # Black user: opponent = even ply (2, 4)
        await bulk_insert_game_flaws(
            db_session,
            [
                _flaw_row(user_id=99999, game_id=game_black.id, ply=2, severity=_SEV_BLUNDER),
                _flaw_row(user_id=99999, game_id=game_black.id, ply=4, severity=_SEV_BLUNDER),
            ],
        )

        # GATED result must equal the baseline (no regression invariant — D-04)
        gated = await fetch_stats_aggregates(
            db_session,
            user_id=99999,
            analyzed_game_ids_subq=analyzed_subq,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            opponent_gap_min=None,
            opponent_gap_max=None,
            color=None,
        )
        gated_total = gated[0] + gated[1]  # mistake + blunder
        assert gated_total == baseline_total, (
            f"gated aggregate (D-04) must equal pre-phase baseline: "
            f"got {gated_total}, expected {baseline_total} "
            "(opponent rows must not inflate the stats panel)"
        )

        # UNGATED direct count — must exceed baseline (confirms opponent rows present)
        ungated_count_row = (
            await db_session.execute(
                select(func.count())
                .select_from(GameFlaw)
                .where(
                    GameFlaw.user_id == 99999,
                    GameFlaw.game_id.in_([game_white.id, game_black.id]),
                )
            )
        ).scalar_one()
        assert ungated_count_row > baseline_total, (
            f"ungated row count ({ungated_count_row}) must exceed player-only "
            f"baseline ({baseline_total}) after both-sides materialization"
        )

    # NOTE: the per-game M+B trend (fetch_stats_trend) was removed in the flaw-trend
    # rebuild — the trend chart now reads the games-table oracle columns
    # (white_/black_blunders/mistakes/inaccuracies) via fetch_flaw_trend_rows, which are
    # inherently player-only by color selection, so no game_flaws player-gating applies.


# ---------------------------------------------------------------------------
# TestFetchPageActiveEvalStatus (-k active_eval_status)
# ---------------------------------------------------------------------------


class TestFetchPageActiveEvalStatus:
    """fetch_page_active_eval_status: batch active eval-job status per game."""

    @pytest.mark.asyncio
    async def test_pending_job_returns_pending(self, db_session: AsyncSession) -> None:
        """A game with a 'pending' eval_jobs row yields active_eval_status == 'pending'."""
        from app.models.eval_jobs import EvalJob
        from app.repositories.library_repository import fetch_page_active_eval_status

        game = await _seed_game(db_session)
        job = EvalJob(tier=1, user_id=game.user_id, game_id=game.id, status="pending")
        db_session.add(job)
        await db_session.flush()

        result = await fetch_page_active_eval_status(db_session, game.user_id, [game.id])
        assert result.get(game.id) == "pending"

    @pytest.mark.asyncio
    async def test_leased_job_returns_leased(self, db_session: AsyncSession) -> None:
        """A game with a 'leased' eval_jobs row yields active_eval_status == 'leased'."""
        from app.models.eval_jobs import EvalJob
        from app.repositories.library_repository import fetch_page_active_eval_status

        game = await _seed_game(db_session)
        job = EvalJob(tier=1, user_id=game.user_id, game_id=game.id, status="leased")
        db_session.add(job)
        await db_session.flush()

        result = await fetch_page_active_eval_status(db_session, game.user_id, [game.id])
        assert result.get(game.id) == "leased"

    @pytest.mark.asyncio
    async def test_no_active_job_absent_from_result(self, db_session: AsyncSession) -> None:
        """A game with no eval_jobs row is absent from the result dict."""
        from app.repositories.library_repository import fetch_page_active_eval_status

        game = await _seed_game(db_session)

        result = await fetch_page_active_eval_status(db_session, game.user_id, [game.id])
        assert game.id not in result

    @pytest.mark.asyncio
    async def test_completed_job_absent_from_result(self, db_session: AsyncSession) -> None:
        """A game with only a 'completed' eval_jobs row is absent (not active)."""
        from app.models.eval_jobs import EvalJob
        from app.repositories.library_repository import fetch_page_active_eval_status

        game = await _seed_game(db_session)
        job = EvalJob(tier=1, user_id=game.user_id, game_id=game.id, status="completed")
        db_session.add(job)
        await db_session.flush()

        result = await fetch_page_active_eval_status(db_session, game.user_id, [game.id])
        assert game.id not in result

    @pytest.mark.asyncio
    async def test_empty_game_ids_returns_empty_dict(self, db_session: AsyncSession) -> None:
        """Empty game_ids list returns empty dict immediately (early-return guard)."""
        from app.repositories.library_repository import fetch_page_active_eval_status

        result = await fetch_page_active_eval_status(db_session, 99999, [])
        assert result == {}

    @pytest.mark.asyncio
    async def test_multiple_games_mixed_status(self, db_session: AsyncSession) -> None:
        """Batch result correctly maps multiple games with different statuses."""
        from app.models.eval_jobs import EvalJob
        from app.repositories.library_repository import fetch_page_active_eval_status

        game_pending = await _seed_game(db_session)
        game_leased = await _seed_game(db_session)
        game_no_job = await _seed_game(db_session)

        db_session.add(
            EvalJob(tier=1, user_id=game_pending.user_id, game_id=game_pending.id, status="pending")
        )
        db_session.add(
            EvalJob(tier=1, user_id=game_leased.user_id, game_id=game_leased.id, status="leased")
        )
        await db_session.flush()

        game_ids = [game_pending.id, game_leased.id, game_no_job.id]
        result = await fetch_page_active_eval_status(db_session, 99999, game_ids)

        assert result.get(game_pending.id) == "pending"
        assert result.get(game_leased.id) == "leased"
        assert game_no_job.id not in result


# ---------------------------------------------------------------------------
# Phase 128 Plan 03 (Task 2 TDD) — orientation tests for filter + chip read
# ---------------------------------------------------------------------------


def _compile_flaw_filter_sql(tactic_families: list[str], orientation: str | None = None) -> str:
    """Compile build_flaw_filter_clauses with optional orientation to SQL text."""
    from sqlalchemy import select
    from sqlalchemy.dialects import postgresql

    from app.repositories.library_repository import build_flaw_filter_clauses

    kwargs: dict = dict(
        severity=[],
        tags=[],
        tactic_families=tactic_families,
    )
    if orientation is not None:
        kwargs["orientation"] = orientation
    clauses = build_flaw_filter_clauses(**kwargs)  # type: ignore[arg-type]
    if not clauses:
        return ""
    from sqlalchemy import and_

    from app.models.game_flaw import GameFlaw

    stmt = select(GameFlaw.ply).where(and_(*clauses))
    return str(
        stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": False},
        )
    )


class TestTacticOrientationBuildFlawFilterClauses:
    """build_flaw_filter_clauses orientation param selects the correct column (D-09).

    Phase 128 Task 2 TDD RED: these tests expect an orientation parameter on
    build_flaw_filter_clauses that does not exist yet — they will fail with a
    TypeError until the GREEN implementation lands.
    """

    def test_default_orientation_references_both_columns(self) -> None:
        """orientation unspecified (default = 'either') → clause references both columns.

        Quick 260621-sm8: default changed from 'allowed' to 'either' so callers
        that don't pass an orientation param (e.g. flaw_exists_from_table) still
        get the all-inclusive 'either' behaviour rather than orientation-filtering.
        """
        sql = _compile_flaw_filter_sql(["fork"])
        assert "allowed_tactic_motif" in sql, (
            f"Default orientation must reference allowed_tactic_motif; got: {sql}"
        )
        assert "missed_tactic_motif" in sql, (
            f"Default orientation must also reference missed_tactic_motif; got: {sql}"
        )

    def test_allowed_orientation_references_allowed_column(self) -> None:
        """orientation='allowed' → clause references allowed_tactic_motif."""
        sql = _compile_flaw_filter_sql(["fork"], orientation="allowed")
        assert "allowed_tactic_motif" in sql, (
            f"orientation='allowed' must reference allowed_tactic_motif; got: {sql}"
        )
        assert "missed_tactic_motif" not in sql, (
            f"orientation='allowed' must NOT reference missed_tactic_motif; got: {sql}"
        )

    def test_missed_orientation_references_missed_column(self) -> None:
        """orientation='missed' → clause references missed_tactic_motif.

        The FAMILY_TO_MOTIF_INTS expansion is identical (D-09); only the column
        switches.
        """
        sql = _compile_flaw_filter_sql(["fork"], orientation="missed")
        assert "missed_tactic_motif" in sql, (
            f"orientation='missed' must reference missed_tactic_motif; got: {sql}"
        )
        assert "allowed_tactic_motif" not in sql, (
            f"orientation='missed' must NOT reference allowed_tactic_motif; got: {sql}"
        )

    def test_also_gates_on_matched_confidence_column(self) -> None:
        """Confidence gate uses the same orientation's confidence column (not cross-pollinated)."""
        sql_allowed = _compile_flaw_filter_sql(["fork"], orientation="allowed")
        assert "allowed_tactic_confidence" in sql_allowed, (
            f"allowed orientation must gate on allowed_tactic_confidence; got: {sql_allowed}"
        )
        assert "missed_tactic_confidence" not in sql_allowed

        sql_missed = _compile_flaw_filter_sql(["fork"], orientation="missed")
        assert "missed_tactic_confidence" in sql_missed, (
            f"missed orientation must gate on missed_tactic_confidence; got: {sql_missed}"
        )
        assert "allowed_tactic_confidence" not in sql_missed

    def test_family_to_motif_ints_defined_once_not_duplicated(self) -> None:
        """FAMILY_TO_MOTIF_INTS has a single definition (not per-orientation duplicate)."""
        import subprocess

        result = subprocess.run(
            ["grep", "-c", "FAMILY_TO_MOTIF_INTS", "app/repositories/library_repository.py"],
            capture_output=True,
            text=True,
        )
        count = int(result.stdout.strip())
        # Expect 1 definition + comment references + usages in query logic.
        # The important thing: FAMILY_TO_MOTIF_INTS should NOT appear N times as separate
        # per-orientation dicts. The exact count is flexible; just verify it's not doubled.
        # Phase 129 Plan 01 raised the upper bound from 8 to 15 (added _depth_in_range +
        # _tactic_orientation_pairs helpers with docstring + code references — not duplication).
        assert count >= 2, "FAMILY_TO_MOTIF_INTS must appear at least twice (def + usage)"
        assert count <= 15, f"FAMILY_TO_MOTIF_INTS appears {count} times — possible duplication"


# ---------------------------------------------------------------------------
# Phase 129 Plan 01 (Task 1 TDD RED) — depth + either tests for build_flaw_filter_clauses
# ---------------------------------------------------------------------------


def _compile_flaw_filter_sql_129(
    tactic_families: list[str],
    orientation: str = "allowed",
    min_tactic_depth: int | None = None,
    max_tactic_depth: int | None = None,
) -> str:
    """Compile build_flaw_filter_clauses with orientation + depth to SQL text."""
    from sqlalchemy import and_, select
    from sqlalchemy.dialects import postgresql

    from app.models.game_flaw import GameFlaw
    from app.repositories.library_repository import build_flaw_filter_clauses

    kwargs: dict = dict(
        severity=[],
        tags=[],
        tactic_families=tactic_families,
        orientation=orientation,
    )
    if min_tactic_depth is not None:
        kwargs["min_tactic_depth"] = min_tactic_depth
    if max_tactic_depth is not None:
        kwargs["max_tactic_depth"] = max_tactic_depth
    clauses = build_flaw_filter_clauses(**kwargs)  # type: ignore[arg-type]
    if not clauses:
        return ""
    stmt = select(GameFlaw.ply).where(and_(*clauses))
    return str(
        stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": False},
        )
    )


class TestTacticDepthAndEitherBuildFlawFilterClauses:
    """build_flaw_filter_clauses depth + either tests (Phase 129 D-05/D-08).

    Phase 129 Task 1 TDD RED: these tests expect max_tactic_depth kwarg and
    orientation='either' support that do not yet exist. They will fail with
    TypeError or assertion errors until the GREEN implementation lands.
    """

    def test_either_references_both_motif_columns(self) -> None:
        """orientation='either' → clause includes BOTH missed and allowed motif columns."""
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="either")
        assert "missed_tactic_motif" in sql, (
            f"either orientation must reference missed_tactic_motif; got: {sql}"
        )
        assert "allowed_tactic_motif" in sql, (
            f"either orientation must reference allowed_tactic_motif; got: {sql}"
        )

    def test_either_gates_on_both_confidence_columns(self) -> None:
        """orientation='either' → confidence gate appears on both column sets."""
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="either")
        assert "missed_tactic_confidence" in sql, (
            f"either orientation must gate on missed_tactic_confidence; got: {sql}"
        )
        assert "allowed_tactic_confidence" in sql, (
            f"either orientation must gate on allowed_tactic_confidence; got: {sql}"
        )

    def test_depth_none_omits_depth_column(self) -> None:
        """max_tactic_depth=None → no depth column in the clause."""
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="allowed", max_tactic_depth=None)
        assert "allowed_tactic_depth" not in sql, (
            f"max_tactic_depth=None must NOT add allowed_tactic_depth predicate; got: {sql}"
        )

    def test_depth_bound_references_depth_column(self) -> None:
        """max_tactic_depth=3 → allowed_tactic_depth predicate added."""
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="allowed", max_tactic_depth=3)
        assert "allowed_tactic_depth" in sql, (
            f"max_tactic_depth=3 must add allowed_tactic_depth predicate; got: {sql}"
        )

    def test_missed_depth_bound_references_missed_depth_column(self) -> None:
        """orientation='missed' + max_tactic_depth → missed_tactic_depth predicate."""
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="missed", max_tactic_depth=3)
        assert "missed_tactic_depth" in sql, (
            f"missed + depth must add missed_tactic_depth predicate; got: {sql}"
        )
        assert "allowed_tactic_depth" not in sql, (
            f"missed orientation must NOT reference allowed_tactic_depth; got: {sql}"
        )

    def test_mate_exemption_removed_when_depth_set(self) -> None:
        """Quick 260620-l5k: mates now obey the range — NO depth-exemption OR.

        The Phase 129 D-04 mate exemption was removed, so a bounded depth filter
        references the motif column ONCE (the primary family filter) — not twice.
        """
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="allowed", max_tactic_depth=3)
        # Quick 260621-qz9: the allowed column is decision-anchored (+1), so the
        # upper bound now compiles as "allowed_tactic_depth + <param> <=".
        assert "allowed_tactic_depth +" in sql and "<=" in sql
        # The mate exemption was the ONLY OR in a single-orientation depth clause
        # (depth <= N OR motif IN mate_ints). Its removal leaves a pure AND chain.
        assert " OR " not in sql, (
            f"Mate exemption removed → no OR in a single-orientation depth clause; got: {sql}"
        )

    def test_min_depth_bound_references_depth_column(self) -> None:
        """Quick 260620-l5k: min_tactic_depth=2 → a >= lower-bound predicate is added.

        Quick 260621-qz9: the allowed column carries the decision-anchored +1 offset,
        so both bounds compile as "allowed_tactic_depth + <param>" comparisons.
        """
        sql = _compile_flaw_filter_sql_129(
            ["fork"], orientation="allowed", min_tactic_depth=2, max_tactic_depth=5
        )
        assert "allowed_tactic_depth +" in sql and ">=" in sql, (
            f"min_tactic_depth=2 must add an offset 'allowed_tactic_depth + ... >=' predicate; got: {sql}"
        )
        assert "allowed_tactic_depth +" in sql and "<=" in sql, (
            f"max_tactic_depth=5 must add an offset 'allowed_tactic_depth + ... <=' predicate; got: {sql}"
        )

    def test_allowed_depth_is_decision_anchored_offset_missed_is_not(self) -> None:
        """Quick 260621-qz9: allowed depth column is shifted +1; missed is bare.

        The allowed_tactic PV (opponent refutation) starts one ply after the shared
        decision board, so its raw 0-based index is compared as raw+1 to land on the
        same decision-anchored scale as missed. Missed keeps the bare column.
        """
        allowed_sql = _compile_flaw_filter_sql_129(
            ["fork"], orientation="allowed", min_tactic_depth=2, max_tactic_depth=5
        )
        assert "allowed_tactic_depth +" in allowed_sql, (
            f"allowed orientation must offset the depth column (+1); got: {allowed_sql}"
        )

        missed_sql = _compile_flaw_filter_sql_129(
            ["fork"], orientation="missed", min_tactic_depth=2, max_tactic_depth=5
        )
        assert "missed_tactic_depth >=" in missed_sql, (
            f"missed orientation must compare the bare column (no offset); got: {missed_sql}"
        )
        assert "missed_tactic_depth +" not in missed_sql, (
            f"missed orientation must NOT offset the depth column; got: {missed_sql}"
        )

    def test_either_depth_references_both_depth_columns(self) -> None:
        """orientation='either' + max_tactic_depth → both depth columns."""
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="either", max_tactic_depth=3)
        assert "missed_tactic_depth" in sql, (
            f"either + depth must reference missed_tactic_depth; got: {sql}"
        )
        assert "allowed_tactic_depth" in sql, (
            f"either + depth must reference allowed_tactic_depth; got: {sql}"
        )

    def test_confidence_gate_preserved_on_either(self) -> None:
        """Flaws-list site DOES gate confidence (Pitfall 3) even for 'either'."""
        sql = _compile_flaw_filter_sql_129(["fork"], orientation="either")
        assert "tactic_confidence" in sql, (
            f"build_flaw_filter_clauses must gate confidence for either; got: {sql}"
        )


# ---------------------------------------------------------------------------
# TestDecidedLostSuppression (Quick 260626-bdt)
# ---------------------------------------------------------------------------


class TestDecidedLostSuppression:
    """Decided-lost tactic suppression: flaws from positions already lost for the
    mover have their tactic-motif tag + depth suppressed on the Flaws and Games
    surfaces.  The flaw still exists and counts in severity totals (Quick 260626-bdt).
    """

    # ------------------------------------------------------------------
    # Helpers for this class
    # ------------------------------------------------------------------

    async def _ensure_dl_user(self, session: AsyncSession) -> None:
        """Ensure _DL_USER_ID exists in the users table (FK constraint)."""
        from tests.conftest import ensure_test_user

        await ensure_test_user(session, _DL_USER_ID)

    async def _query_flaws_fork(
        self,
        session: AsyncSession,
        *,
        user_id: int = _DL_USER_ID,
        orientation: TacticOrientation = "allowed",
    ) -> tuple[list[Any], int]:
        """Helper: query_flaws with tactic_families=['fork'] and explicit orientation."""
        return await query_flaws(
            session,
            user_id=user_id,
            severity=["mistake", "blunder"],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            tactic_families=["fork"],
            orientation=orientation,
            offset=0,
            limit=50,
        )

    async def _games_path_matching_ids(
        self,
        session: AsyncSession,
        *,
        user_id: int = _DL_USER_ID,
    ) -> set[int]:
        """Run apply_game_filters with tactic_families=['fork'] on the Games path."""
        stmt = select(Game.id).where(Game.user_id == user_id)
        stmt = apply_game_filters(
            stmt,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            tactic_families=["fork"],
            user_id=user_id,
        )
        rows = (await session.execute(stmt)).scalars().all()
        return set(rows)

    # ------------------------------------------------------------------
    # Test 1: decided-lost fork excluded from motif filter
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_decided_lost_fork_excluded_from_motif_filter(
        self, db_session: AsyncSession
    ) -> None:
        """Decided-lost fork (eval_cp_before=-900) excluded; contestable fork included.

        White mover: eval_cp=-900 is decisively lost (>= MATE_LADDER_LOPSIDED_CP=700
        from white's perspective, i.e. white is losing). The fork chip is suppressed
        so query_flaws(tactic_families=["fork"]) returns 0 for that flaw.
        A second flaw in a contestable position (eval_cp=-100) with the same fork
        IS returned.
        """
        from app.services.tactic_detector import TacticMotifInt
        from app.repositories.library_repository import MATE_LADDER_LOPSIDED_CP

        await self._ensure_dl_user(db_session)
        game = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        try:
            # Decided-lost flaw at even ply (white mover); pre-move eval_cp = -900 → lost.
            await _seed_position(db_session, game=game, ply=1, eval_cp=-900)
            await _seed_game_flaw(
                db_session,
                game=game,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            # Control flaw at ply 4 in a contestable position (eval_cp=-100 < threshold).
            await _seed_position(db_session, game=game, ply=3, eval_cp=-100)
            await _seed_game_flaw(
                db_session,
                game=game,
                ply=4,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )

            items, count = await self._query_flaws_fork(db_session)
            plies = [item.ply for item in items if item.game_id == game.id]
            assert 2 not in plies, (
                f"decided-lost fork at ply=2 (eval_cp=-{MATE_LADDER_LOPSIDED_CP + 200}) "
                "must be excluded by the motif filter"
            )
            assert 4 in plies, "contestable fork at ply=4 (eval_cp=-100) must be included"
            assert count >= 1
        finally:
            await db_session.execute(delete(Game).where(Game.id == game.id))

    # ------------------------------------------------------------------
    # Test 2: decided-lost flaw still counts in severity, tag nulled
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_decided_lost_flaw_still_counts_severity(self, db_session: AsyncSession) -> None:
        """Decided-lost flaw appears without tactic filter but with tag suppressed.

        The flaw (blunder, eval_cp_before=-900) still appears in an unfiltered
        query_flaws call. Its severity is 'blunder' and the row is present.
        But its allowed_tactic_motif and allowed_tactic_depth are None (suppressed).
        """
        from app.services.tactic_detector import TacticMotifInt

        await self._ensure_dl_user(db_session)
        game = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        try:
            await _seed_position(db_session, game=game, ply=1, eval_cp=-900)
            await _seed_game_flaw(
                db_session,
                game=game,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=2,
            )

            # Unfiltered query (no tactic filter) — flaw must appear.
            items, count = await query_flaws(
                db_session,
                user_id=_DL_USER_ID,
                severity=["blunder"],
                tags=[],
                time_control=None,
                platform=None,
                rated=None,
                opponent_type="all",
                from_date=None,
                to_date=None,
                color=None,
                offset=0,
                limit=50,
            )
            our_flaw = next(
                (item for item in items if item.game_id == game.id and item.ply == 2), None
            )
            assert our_flaw is not None, (
                "decided-lost blunder must still appear in unfiltered query_flaws"
            )
            assert our_flaw.severity == "blunder", "severity must be 'blunder'"
            assert our_flaw.allowed_tactic_motif is None, (
                "allowed_tactic_motif must be None (suppressed) on decided-lost flaw"
            )
            assert our_flaw.allowed_tactic_depth is None, (
                "allowed_tactic_depth must be None (suppressed) on decided-lost flaw"
            )
            assert count >= 1
        finally:
            await db_session.execute(delete(Game).where(Game.id == game.id))

    # ------------------------------------------------------------------
    # Test 3: null pre-move eval fails open
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_null_pre_move_eval_fails_open(self, db_session: AsyncSession) -> None:
        """Null pre-move eval (no PositionBefore or both eval columns NULL) fails open.

        A flaw whose ply N-1 position has eval_cp=None AND eval_mate=None must NOT
        be suppressed: query_flaws(tactic_families=["fork"]) must return the row,
        and the serialized allowed_tactic_motif must be non-None.
        """
        from app.services.tactic_detector import TacticMotifInt

        await self._ensure_dl_user(db_session)
        game = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        try:
            # Pre-move position exists but both eval columns are NULL → fail open.
            await _seed_position(db_session, game=game, ply=1, eval_cp=None, eval_mate=None)
            await _seed_game_flaw(
                db_session,
                game=game,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )

            items, count = await self._query_flaws_fork(db_session)
            our_flaw = next(
                (item for item in items if item.game_id == game.id and item.ply == 2), None
            )
            assert our_flaw is not None, (
                "null pre-move eval must fail open: fork flaw must appear in tactic filter"
            )
            assert our_flaw.allowed_tactic_motif is not None, (
                "null pre-move eval must fail open: allowed_tactic_motif must be non-None"
            )
            assert count >= 1
        finally:
            await db_session.execute(delete(Game).where(Game.id == game.id))

    # ------------------------------------------------------------------
    # Test 4: Flaws path and Games path agree
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_flaws_and_games_paths_agree(self, db_session: AsyncSession) -> None:
        """Flaws path (query_flaws) and Games path (flaw_exists_from_table) agree.

        One decided-lost fork game, one contestable fork game:
        - query_flaws(tactic_families=["fork"]) returns only the contestable game.
        - apply_game_filters(tactic_families=["fork"]) (Games tab EXISTS) returns the same set.
        """
        from app.services.tactic_detector import TacticMotifInt

        await self._ensure_dl_user(db_session)
        game_dl = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        game_ok = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        try:
            # Decided-lost game
            await _seed_position(db_session, game=game_dl, ply=1, eval_cp=-900)
            await _seed_game_flaw(
                db_session,
                game=game_dl,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            # Contestable game
            await _seed_position(db_session, game=game_ok, ply=1, eval_cp=-100)
            await _seed_game_flaw(
                db_session,
                game=game_ok,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )

            # Flaws path
            flaws_items, _ = await self._query_flaws_fork(db_session)
            flaws_game_ids = {item.game_id for item in flaws_items}

            # Games path (apply_game_filters / flaw_exists_from_table)
            games_game_ids = await self._games_path_matching_ids(db_session)

            # Both paths must agree: contestable matches, decided-lost does not.
            # Filter to only our seeded games to avoid cross-test contamination.
            our_flaws_ids = flaws_game_ids & {game_dl.id, game_ok.id}
            our_games_ids = games_game_ids & {game_dl.id, game_ok.id}

            assert game_ok.id in our_flaws_ids, "contestable fork game must appear in Flaws path"
            assert game_dl.id not in our_flaws_ids, (
                "decided-lost fork must NOT appear in Flaws path"
            )
            assert game_ok.id in our_games_ids, "contestable fork game must appear in Games path"
            assert game_dl.id not in our_games_ids, (
                "decided-lost fork must NOT appear in Games path"
            )
            assert our_flaws_ids == our_games_ids, (
                "Flaws and Games paths must agree on which games match the tactic filter"
            )
        finally:
            await db_session.execute(delete(Game).where(Game.id.in_([game_dl.id, game_ok.id])))

    # ------------------------------------------------------------------
    # Test 5: POV sign-flip for both colors + winning-side non-suppression
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_pov_sign_flip(self, db_session: AsyncSession) -> None:
        """Suppression is POV-correct for both colors; winning side is NOT suppressed.

        (a) White mover, eval_cp_before=-800 → suppressed.
        (b) Black mover (black user, ODD ply passes player_only_gate), eval_cp_before=+800 → suppressed.
        (c) White mover, eval_cp_before=+800 (winning) → NOT suppressed.
        (d) Black mover, eval_cp_before=-800 (winning) → NOT suppressed.
        Mate variant: white mover eval_mate_before=-2 suppressed; eval_mate_before=+2 not.
        """
        from app.services.tactic_detector import TacticMotifInt

        await self._ensure_dl_user(db_session)

        # (a) White mover losing
        game_a = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        # (b) Black user, ODD ply → black mover = player; white-POV eval_cp=+800 → black losing.
        game_b = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="black")
        # (c) White mover winning
        game_c = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        # (d) Black user winning (white-POV eval_cp=-800 → black winning)
        game_d = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="black")
        # (e) White mover, eval_mate_before=-2 (Black has mate) → suppressed
        game_e = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        # (f) White mover, eval_mate_before=+2 (White has mate) → NOT suppressed
        game_f = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        all_games = [game_a, game_b, game_c, game_d, game_e, game_f]
        try:
            # (a) white mover at ply=2 (even); ply=1 has eval_cp=-800 (white losing)
            await _seed_position(db_session, game=game_a, ply=1, eval_cp=-800)
            await _seed_game_flaw(
                db_session,
                game=game_a,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            # (b) black user, odd ply=1 (black mover = player); ply=0 eval_cp=+800 (black losing)
            await _seed_position(db_session, game=game_b, ply=0, eval_cp=800)
            await _seed_game_flaw(
                db_session,
                game=game_b,
                ply=1,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            # (c) white mover at ply=2; ply=1 eval_cp=+800 (white winning) → NOT suppressed
            await _seed_position(db_session, game=game_c, ply=1, eval_cp=800)
            await _seed_game_flaw(
                db_session,
                game=game_c,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            # (d) black user, odd ply=1 (black mover); ply=0 eval_cp=-800 (black winning) → NOT suppressed
            await _seed_position(db_session, game=game_d, ply=0, eval_cp=-800)
            await _seed_game_flaw(
                db_session,
                game=game_d,
                ply=1,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            # (e) white mover at ply=2; ply=1 eval_mate=-2 (Black has mate-in-2) → suppressed
            await _seed_position(db_session, game=game_e, ply=1, eval_mate=-2)
            await _seed_game_flaw(
                db_session,
                game=game_e,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            # (f) white mover at ply=2; ply=1 eval_mate=+2 (White has mate-in-2) → NOT suppressed
            await _seed_position(db_session, game=game_f, ply=1, eval_mate=2)
            await _seed_game_flaw(
                db_session,
                game=game_f,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )

            # Flaws filter with tactic_families=["fork"], orientation="either"
            items, _ = await query_flaws(
                db_session,
                user_id=_DL_USER_ID,
                severity=["blunder"],
                tags=[],
                time_control=None,
                platform=None,
                rated=None,
                opponent_type="all",
                from_date=None,
                to_date=None,
                color=None,
                tactic_families=["fork"],
                orientation="either",
                offset=0,
                limit=50,
            )
            matched_game_ids = {item.game_id for item in items}

            assert game_a.id not in matched_game_ids, "(a) white mover losing must be suppressed"
            assert game_b.id not in matched_game_ids, "(b) black mover losing must be suppressed"
            assert game_c.id in matched_game_ids, "(c) white mover winning must NOT be suppressed"
            assert game_d.id in matched_game_ids, "(d) black mover winning must NOT be suppressed"
            assert game_e.id not in matched_game_ids, "(e) eval_mate_before=-2 must be suppressed"
            assert game_f.id in matched_game_ids, "(f) eval_mate_before=+2 must NOT be suppressed"
        finally:
            await db_session.execute(delete(Game).where(Game.id.in_([g.id for g in all_games])))

    # ------------------------------------------------------------------
    # Test 6: boundary threshold — -700 is suppressed, -300 is not
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_boundary_threshold(self, db_session: AsyncSession) -> None:
        """eval_cp_before == -MATE_LADDER_LOPSIDED_CP (-700) is suppressed (inclusive).

        A flaw at eval_cp_before = -300 (still playable) is NOT suppressed.
        Verifies the inclusive <= boundary in is_decided_lost.
        """
        from app.services.tactic_detector import TacticMotifInt
        from app.repositories.library_repository import MATE_LADDER_LOPSIDED_CP

        await self._ensure_dl_user(db_session)
        # Boundary game: exactly at -MATE_LADDER_LOPSIDED_CP (-700) → suppressed
        game_boundary = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        # Playable game: eval_cp = -300 → not suppressed
        game_playable = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        try:
            await _seed_position(
                db_session, game=game_boundary, ply=1, eval_cp=-MATE_LADDER_LOPSIDED_CP
            )
            await _seed_game_flaw(
                db_session,
                game=game_boundary,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )
            await _seed_position(db_session, game=game_playable, ply=1, eval_cp=-300)
            await _seed_game_flaw(
                db_session,
                game=game_playable,
                ply=2,
                severity=2,
                allowed_tactic_motif=int(TacticMotifInt.FORK),
                allowed_tactic_confidence=100,
                allowed_tactic_depth=0,
            )

            items, _ = await self._query_flaws_fork(db_session)
            matched_ids = {item.game_id for item in items}

            assert game_boundary.id not in matched_ids, (
                f"eval_cp_before==-{MATE_LADDER_LOPSIDED_CP} must be suppressed (inclusive boundary)"
            )
            assert game_playable.id in matched_ids, (
                "eval_cp_before==-300 must NOT be suppressed (below threshold)"
            )
        finally:
            await db_session.execute(
                delete(Game).where(Game.id.in_([game_boundary.id, game_playable.id]))
            )

    # ------------------------------------------------------------------
    # Test 7: missed-orientation suppression (parity with the allowed tests)
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_decided_lost_missed_orientation_excluded_and_nulled(
        self, db_session: AsyncSession
    ) -> None:
        """Decided-lost suppression covers the `missed` slot, not just `allowed`.

        Seeds a fork in the MISSED slot of a decided-lost flaw (eval_cp_before=-900,
        white mover). Asserts (a) it is excluded from query_flaws with
        orientation="missed", (b) a contestable missed-fork is still returned, and
        (c) the suppressed flaw's missed_tactic_motif/depth serialize to None on the
        unfiltered query while the flaw itself still appears (severity intact).

        Guards against an asymmetry where suppression would only gate the allowed
        orientation. The SQL gate wraps or_(allowed, missed) and tactic_slot_visible
        short-circuits before the orientation check, so both slots must be covered.
        """
        from app.services.tactic_detector import TacticMotifInt

        await self._ensure_dl_user(db_session)
        game = await _seed_game(db_session, user_id=_DL_USER_ID, user_color="white")
        try:
            # Decided-lost missed-fork at ply=2 (white mover); pre-move eval_cp=-900.
            await _seed_position(db_session, game=game, ply=1, eval_cp=-900)
            await _seed_game_flaw(
                db_session,
                game=game,
                ply=2,
                severity=2,
                missed_tactic_motif=int(TacticMotifInt.FORK),
                missed_tactic_confidence=100,
                missed_tactic_depth=0,
            )
            # Control: contestable missed-fork at ply=4 (eval_cp=-100 < threshold).
            await _seed_position(db_session, game=game, ply=3, eval_cp=-100)
            await _seed_game_flaw(
                db_session,
                game=game,
                ply=4,
                severity=2,
                missed_tactic_motif=int(TacticMotifInt.FORK),
                missed_tactic_confidence=100,
                missed_tactic_depth=0,
            )

            # (a)/(b): orientation="missed" excludes the decided-lost flaw, keeps the control.
            items, count = await self._query_flaws_fork(db_session, orientation="missed")
            plies = [item.ply for item in items if item.game_id == game.id]
            assert 2 not in plies, (
                "decided-lost missed-fork at ply=2 (eval_cp=-900) must be excluded "
                "by the missed-orientation motif filter"
            )
            assert 4 in plies, "contestable missed-fork at ply=4 must be included"
            assert count >= 1

            # (c): unfiltered query — the decided-lost flaw still appears with the
            # missed tactic slot nulled (tag suppressed) but severity intact.
            all_items, _ = await query_flaws(
                db_session,
                user_id=_DL_USER_ID,
                severity=["blunder"],
                tags=[],
                time_control=None,
                platform=None,
                rated=None,
                opponent_type="all",
                from_date=None,
                to_date=None,
                color=None,
                tactic_families=[],
                orientation="either",
                offset=0,
                limit=50,
            )
            suppressed = next((i for i in all_items if i.game_id == game.id and i.ply == 2), None)
            assert suppressed is not None, "decided-lost flaw must still exist (counts)"
            assert suppressed.severity == "blunder"
            assert suppressed.missed_tactic_motif is None, (
                "missed_tactic_motif must be None (suppressed) on decided-lost flaw"
            )
            assert suppressed.missed_tactic_depth is None, (
                "missed_tactic_depth must be None (suppressed) on decided-lost flaw"
            )
        finally:
            await db_session.execute(delete(Game).where(Game.id == game.id))


# ---------------------------------------------------------------------------
# Phase 175 Plan 01 (FILT-01) — has_gem / has_great filter (-k best_move_exists)
# ---------------------------------------------------------------------------

# Distinct user IDs so parallel -n auto runs cannot cross-contaminate with
# other classes' fixtures in this module (mirrors _DL_USER_ID's rationale).
_BMF_USER_ID = 99996
_BMF_OTHER_USER_ID = 99994


async def _seed_best_move(
    session: AsyncSession,
    *,
    game: Game,
    ply: int,
    maia_prob: float,
    best_cp: int | None = 250,
    best_mate: int | None = None,
    second_cp: int | None = 0,
    second_mate: int | None = None,
) -> None:
    """Insert a game_best_moves row directly (no user_id column — position-scoped
    candidacy, per GameBestMove's model docstring).

    Defaults (best_cp=250 vs second_cp=0) produce a wide WHITE-mover expected-
    score margin (~0.21, comfortably >= MISTAKE_DROP 0.10); pass a mirrored
    negative best_cp when seeding a BLACK user's own-move row (matches
    classify_best_move's black-mover sign-flip convention).
    """
    from app.models.game_best_move import GameBestMove

    row = GameBestMove(
        game_id=game.id,
        ply=ply,
        maia_prob=maia_prob,
        best_cp=best_cp,
        best_mate=best_mate,
        second_cp=second_cp,
        second_mate=second_mate,
    )
    session.add(row)
    await session.flush()


async def _matching_best_move_ids(
    session: AsyncSession,
    *,
    user_id: int,
    has_gem: bool | None = None,
    has_great: bool | None = None,
    color: str | None = None,
) -> set[int]:
    """Run apply_game_filters with has_gem/has_great (+ optional color) and
    return the matched game ids, mirroring _matching_game_ids' shape."""
    stmt = select(Game.id).where(Game.user_id == user_id)
    stmt = apply_game_filters(
        stmt,
        time_control=None,
        platform=None,
        rated=None,
        opponent_type="all",
        from_date=None,
        to_date=None,
        color=color,
        has_gem=has_gem,
        has_great=has_great,
    )
    rows = (await session.execute(stmt)).scalars().all()
    return set(rows)


class TestBestMoveExistsFromTable:
    """has_gem / has_great filter (FILT-01) — correlated EXISTS over
    game_best_moves via best_move_exists_from_table, composed through
    apply_game_filters (D-04/D-05/D-05a)."""

    async def _ensure_users(self, session: AsyncSession) -> None:
        from tests.conftest import ensure_test_user

        await ensure_test_user(session, _BMF_USER_ID)
        await ensure_test_user(session, _BMF_OTHER_USER_ID)

    @pytest.mark.asyncio
    async def test_best_move_exists_matches_user_own_move_excludes_opponent_move(
        self, db_session: AsyncSession
    ) -> None:
        """A game where the USER played a gem move matches has_gem=True; a game
        where only the OPPONENT played a gem move does NOT (D-04 player-parity
        scoping) — proves the filter reads the player's own plies only."""
        await self._ensure_users(db_session)

        # White user, own gem at ply=2 (even -> white mover -> player).
        game_own = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_own, ply=2, maia_prob=0.10)

        # Same white user, gem at ply=1 (odd -> black mover -> OPPONENT).
        game_opp = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_opp, ply=1, maia_prob=0.10)

        matched = await _matching_best_move_ids(db_session, user_id=_BMF_USER_ID, has_gem=True)
        assert game_own.id in matched, "game with the user's OWN gem must match has_gem"
        assert game_opp.id not in matched, (
            "game where only the OPPONENT played a gem must NOT match has_gem (D-04)"
        )

    @pytest.mark.asyncio
    async def test_best_move_exists_has_gem_and_has_great_is_a_union(
        self, db_session: AsyncSession
    ) -> None:
        """has_gem=True AND has_great=True returns games with a gem OR a great
        (union semantics), never the intersection (D-05)."""
        await self._ensure_users(db_session)

        game_gem = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_gem, ply=2, maia_prob=0.10)

        game_great = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_great, ply=2, maia_prob=0.35)

        game_neither = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_neither, ply=2, maia_prob=0.60)

        matched = await _matching_best_move_ids(
            db_session, user_id=_BMF_USER_ID, has_gem=True, has_great=True
        )
        assert game_gem.id in matched, "gem-only game must be in the union"
        assert game_great.id in matched, "great-only game must be in the union"
        assert game_neither.id not in matched, "neither-tier game must never match"

        # has_gem alone must exclude the great-only game (not a silent OR-always).
        gem_only = await _matching_best_move_ids(db_session, user_id=_BMF_USER_ID, has_gem=True)
        assert game_gem.id in gem_only
        assert game_great.id not in gem_only, "has_gem alone must not also match great"

    @pytest.mark.asyncio
    async def test_best_move_exists_composes_with_color_filter(
        self, db_session: AsyncSession
    ) -> None:
        """has_gem composes with a simultaneous color filter (D-05a) — a black
        user's own gem is excluded once color=white is added, proving the EXISTS
        is ANDed onto the statement rather than replacing it."""
        await self._ensure_users(db_session)

        game_white = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_white, ply=2, maia_prob=0.10)

        # Black user's own gem: black mover at odd ply, cp mirrored negative
        # (matches classify_best_move's black-mover sign-flip convention).
        game_black = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="black")
        await _seed_best_move(
            db_session, game=game_black, ply=1, maia_prob=0.10, best_cp=-250, second_cp=0
        )

        both = await _matching_best_move_ids(db_session, user_id=_BMF_USER_ID, has_gem=True)
        assert game_white.id in both
        assert game_black.id in both

        white_only = await _matching_best_move_ids(
            db_session, user_id=_BMF_USER_ID, has_gem=True, color="white"
        )
        assert game_white.id in white_only
        assert game_black.id not in white_only, (
            "has_gem must compose with color, not just pass through unfiltered (D-05a)"
        )

    @pytest.mark.asyncio
    async def test_best_move_exists_guard_suppresses_divergent_lichess_gem(
        self, db_session: AsyncSession
    ) -> None:
        """Imported-eval divergence guard (Quick 260717-gmg) end-to-end through the
        EXISTS filter: for a lichess-eval game, a gem candidate whose game_positions
        eval_cp (lichess's post-move %eval) is far worse than our best_cp is dropped
        from has_gem; an otherwise-identical game whose position eval agrees stays.
        """
        await self._ensure_users(db_session)
        lichess_at = datetime.datetime(2026, 4, 6, tzinfo=datetime.timezone.utc)

        # Divergent: our best_cp=250 (es ~0.71) but lichess post-move eval_cp=0
        # (es 0.5) -> 0.21 ES optimism > 0.10 -> guard fires -> excluded.
        game_divergent = await _seed_game(
            db_session, user_id=_BMF_USER_ID, user_color="white", lichess_evals_at=lichess_at
        )
        await _seed_best_move(db_session, game=game_divergent, ply=2, maia_prob=0.10, best_cp=250)
        await _seed_position(db_session, game=game_divergent, ply=2, eval_cp=0)

        # Agreeing: lichess post-move eval matches our best_cp -> no optimism -> kept.
        game_agree = await _seed_game(
            db_session, user_id=_BMF_USER_ID, user_color="white", lichess_evals_at=lichess_at
        )
        await _seed_best_move(db_session, game=game_agree, ply=2, maia_prob=0.10, best_cp=250)
        await _seed_position(db_session, game=game_agree, ply=2, eval_cp=250)

        matched = await _matching_best_move_ids(db_session, user_id=_BMF_USER_ID, has_gem=True)
        assert game_agree.id in matched, "gem whose lichess eval agrees must still match has_gem"
        assert game_divergent.id not in matched, (
            "gem whose lichess post-move eval is far worse than our best_cp must be "
            "suppressed by the divergence guard (Quick 260717-gmg)"
        )

    @pytest.mark.asyncio
    async def test_best_move_exists_guard_is_noop_for_engine_games(
        self, db_session: AsyncSession
    ) -> None:
        """The same divergence does NOT suppress when lichess_evals_at is NULL (an
        engine game feeds both surfaces from one engine) — proves the guard is
        scoped to lichess-eval games, not applied blanketly."""
        await self._ensure_users(db_session)

        game_engine = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_engine, ply=2, maia_prob=0.10, best_cp=250)
        await _seed_position(db_session, game=game_engine, ply=2, eval_cp=0)

        matched = await _matching_best_move_ids(db_session, user_id=_BMF_USER_ID, has_gem=True)
        assert game_engine.id in matched, (
            "an engine game (lichess_evals_at NULL) must not be touched by the guard"
        )

    @pytest.mark.asyncio
    async def test_best_move_exists_cross_user_isolation(self, db_session: AsyncSession) -> None:
        """User A's has_gem query never surfaces user B's game (IDOR backstop,
        T-175-01) — game_best_moves has no user_id column, so isolation must
        come entirely from the Game.id correlation to the user-scoped outer
        query, not from a user_id filter on the candidate table itself."""
        await self._ensure_users(db_session)

        game_a = await _seed_game(db_session, user_id=_BMF_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_a, ply=2, maia_prob=0.10)

        game_b = await _seed_game(db_session, user_id=_BMF_OTHER_USER_ID, user_color="white")
        await _seed_best_move(db_session, game=game_b, ply=2, maia_prob=0.10)

        matched_as_a = await _matching_best_move_ids(db_session, user_id=_BMF_USER_ID, has_gem=True)
        assert game_a.id in matched_as_a
        assert game_b.id not in matched_as_a, (
            "user A's has_gem query must not surface user B's game (IDOR)"
        )
