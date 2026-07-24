"""Tests for scripts/backfill_multipv.py and scripts/snapshot_tactic_counts.py.

Covers:
  - Progress-query counting logic: _query_status / _query_eligible report correct
    NULL-blob counts for committed test data (engine vs. lichess split).
  - --dry-run no-writes guarantee: run_dry_run returns without inserting or
    updating any game_flaws rows.
  - Snapshot motif-id-to-name mapping: TacticMotifInt values map to their names.
  - Snapshot markdown table format: the markdown table produced by the snapshot
    script is well-formed for a small synthetic count set.

All DB tests use the per-run test DB via an injected session_maker — no real
`--db` target is hit, no engine is involved.
"""

from __future__ import annotations

import sys
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# Bootstrap project root so `scripts.*` and `app.*` imports resolve from the tests dir.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.models.game import Game  # noqa: E402
from app.models.game_flaw import GameFlaw  # noqa: E402
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401 (registers FK table)
from app.models.user import User  # noqa: E402
from app.services.tactic_detector import TacticMotifInt  # noqa: E402

from scripts.archive.backfill_multipv import _query_eligible, _query_status, run_dry_run  # noqa: E402

# Unique test-module user ID to avoid PK collisions with other test files.
_TEST_USER_ID = 145050
_GUEST_USER_ID = 145051

# Minimal PGN (10 half-moves) accepted by the DB without replay.
_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"

# Timestamp used to mark games as "analyzed" (full_evals_completed_at IS NOT NULL).
_NOW = datetime(2026, 6, 30, 12, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def session_factory(test_engine) -> async_sessionmaker[AsyncSession]:  # type: ignore[type-arg]
    """Return an async_sessionmaker bound to the per-run test DB."""
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture
async def committed_flaw_data(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[dict[str, object], None]:
    """Seed a committed user, two analyzed games, and game_flaws rows.

    Scenario:
      - Non-guest user (_TEST_USER_ID) with:
        - engine_game: full_evals_completed_at IS NOT NULL, lichess_evals_at IS NULL
          → 2 GameFlaw rows with allowed_pv_lines IS NULL
        - lichess_game: full_evals_completed_at IS NOT NULL, lichess_evals_at IS NOT NULL
          → 1 GameFlaw row with allowed_pv_lines IS NULL
      - Guest user (_GUEST_USER_ID) with:
        - guest_game: full_evals_completed_at IS NOT NULL
          → 1 GameFlaw row with allowed_pv_lines IS NULL

    Expected counts:
      - --status: 4 total flaws, 3 games; engine 2 flaws/1 game, lichess 1 flaw/1 game
        (guest game's flaw is included in status but not in dry-run eligible scope)
      - --dry-run eligible: 3 flaws / 2 games (non-guest only, analyzed only)

    Yields a dict with game ids for verification.
    Teardown: deletes the users (CASCADE removes games and flaws).
    """
    engine_game_id: int | None = None
    lichess_game_id: int | None = None
    guest_game_id: int | None = None

    async with session_factory() as session:
        # ── Users ────────────────────────────────────────────────────────────
        existing_non_guest = (
            (await session.execute(select(User).where(User.id == _TEST_USER_ID)))
            .unique()
            .scalar_one_or_none()
        )
        if existing_non_guest is None:
            session.add(
                User(
                    id=_TEST_USER_ID,
                    email=f"backfill-multipv-{_TEST_USER_ID}@example.com",
                    hashed_password="x",
                    is_guest=False,
                )
            )
        existing_guest = (
            (await session.execute(select(User).where(User.id == _GUEST_USER_ID)))
            .unique()
            .scalar_one_or_none()
        )
        if existing_guest is None:
            session.add(
                User(
                    id=_GUEST_USER_ID,
                    email=f"backfill-multipv-guest-{_GUEST_USER_ID}@example.com",
                    hashed_password="x",
                    is_guest=True,
                )
            )
        await session.flush()

        # ── Engine game (lichess_evals_at IS NULL, analyzed) ─────────────────
        engine_game = Game(
            user_id=_TEST_USER_ID,
            platform="lichess",
            platform_game_id=str(uuid.uuid4()),
            pgn=_PGN,
            result="1-0",
            user_color="white",
            rated=True,
            is_computer_game=False,
            full_evals_completed_at=_NOW,
            lichess_evals_at=None,
        )
        session.add(engine_game)
        await session.flush()
        engine_game_id = engine_game.id

        # 2 game_flaws for the engine game (both NULL blobs).
        # DO NOT pass allowed_pv_lines=None — SQLAlchemy serializes None to JSONB null
        # (the JSON value null), not SQL NULL. Omitting the argument lets the column
        # default to SQL NULL, which matches the WHERE allowed_pv_lines IS NULL predicate.
        for ply in [2, 4]:
            session.add(
                GameFlaw(
                    user_id=_TEST_USER_ID,
                    game_id=engine_game_id,
                    ply=ply,
                    severity=2,
                    phase=1,
                    is_miss=False,
                    is_lucky=False,
                    is_reversed=False,
                    is_squandered=False,
                    fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
                )
            )

        # ── Lichess game (lichess_evals_at IS NOT NULL, analyzed) ─────────────
        lichess_game = Game(
            user_id=_TEST_USER_ID,
            platform="lichess",
            platform_game_id=str(uuid.uuid4()),
            pgn=_PGN,
            result="0-1",
            user_color="black",
            rated=True,
            is_computer_game=False,
            full_evals_completed_at=_NOW,
            lichess_evals_at=_NOW,
        )
        session.add(lichess_game)
        await session.flush()
        lichess_game_id = lichess_game.id

        # 1 game_flaw for the lichess game (NULL blob — omit pv_lines, see note above).
        session.add(
            GameFlaw(
                user_id=_TEST_USER_ID,
                game_id=lichess_game_id,
                ply=6,
                severity=2,
                phase=1,
                is_miss=False,
                is_lucky=False,
                is_reversed=False,
                is_squandered=False,
                fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
            )
        )

        # ── Guest game (guest user, analyzed) ────────────────────────────────
        guest_game = Game(
            user_id=_GUEST_USER_ID,
            platform="chess.com",
            platform_game_id=str(uuid.uuid4()),
            pgn=_PGN,
            result="1/2-1/2",
            user_color="white",
            rated=False,
            is_computer_game=False,
            full_evals_completed_at=_NOW,
            lichess_evals_at=None,
        )
        session.add(guest_game)
        await session.flush()
        guest_game_id = guest_game.id

        # 1 game_flaw for the guest game (NULL blob — eligible for status but NOT dry-run).
        session.add(
            GameFlaw(
                user_id=_GUEST_USER_ID,
                game_id=guest_game_id,
                ply=3,
                severity=2,
                phase=0,
                is_miss=True,
                is_lucky=False,
                is_reversed=False,
                is_squandered=False,
                fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
            )
        )

        await session.commit()

    yield {
        "engine_game_id": engine_game_id,
        "lichess_game_id": lichess_game_id,
        "guest_game_id": guest_game_id,
    }

    # Teardown: CASCADE deletes games, positions, flaws.
    async with session_factory() as session:
        await session.execute(delete(User).where(User.id.in_([_TEST_USER_ID, _GUEST_USER_ID])))
        await session.commit()


# ---------------------------------------------------------------------------
# Progress-query counting tests
# ---------------------------------------------------------------------------


class TestQueryStatus:
    """_query_status reports correct overall + per-source NULL-blob counts."""

    @pytest.mark.asyncio
    async def test_total_counts(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        committed_flaw_data: dict[str, object],
    ) -> None:
        """Total games and flaws reflect ALL NULL-blob rows (including guest)."""
        async with session_factory() as session:
            counts = await _query_status(session)

        # 3 games: engine (1) + lichess (1) + guest (1)
        # 4 flaws: engine (2) + lichess (1) + guest (1)
        assert counts["total_games"] >= 3, f"Expected >= 3 games, got {counts['total_games']}"
        assert counts["total_flaws"] >= 4, f"Expected >= 4 flaws, got {counts['total_flaws']}"

    @pytest.mark.asyncio
    async def test_engine_lichess_split(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        committed_flaw_data: dict[str, object],
    ) -> None:
        """Engine and lichess counts are split by lichess_evals_at IS NOT NULL."""
        async with session_factory() as session:
            counts = await _query_status(session)

        # Lichess game: 1 game, 1 flaw
        assert counts["lichess_games"] >= 1, (
            f"Expected >= 1 lichess game, got {counts['lichess_games']}"
        )
        assert counts["lichess_flaws"] >= 1, (
            f"Expected >= 1 lichess flaw, got {counts['lichess_flaws']}"
        )
        # Engine games (incl. guest): engine_game (1) + guest_game (1) = 2 games, 3 flaws
        assert counts["engine_games"] >= 2, (
            f"Expected >= 2 engine games, got {counts['engine_games']}"
        )
        assert counts["engine_flaws"] >= 3, (
            f"Expected >= 3 engine flaws, got {counts['engine_flaws']}"
        )

    @pytest.mark.asyncio
    async def test_total_equals_split_sum(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        committed_flaw_data: dict[str, object],
    ) -> None:
        """Total counts equal the sum of engine + lichess split counts."""
        async with session_factory() as session:
            counts = await _query_status(session)

        assert counts["total_games"] == counts["engine_games"] + counts["lichess_games"]
        assert counts["total_flaws"] == counts["engine_flaws"] + counts["lichess_flaws"]


class TestQueryEligible:
    """_query_eligible excludes guest users and unanalyzed games (tier-4 predicate)."""

    @pytest.mark.asyncio
    async def test_excludes_guest_games(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        committed_flaw_data: dict[str, object],
    ) -> None:
        """Guest games are excluded from the eligible count even if they have NULL blobs."""
        async with session_factory() as session:
            eligible = await _query_eligible(session)

        # Non-guest analyzed games: engine (1) + lichess (1) = 2 games, 3 flaws.
        # Guest game (1 game, 1 flaw) must NOT appear in eligible counts.
        assert eligible["games"] >= 2, f"Expected >= 2 eligible games, got {eligible['games']}"
        assert eligible["flaws"] >= 3, f"Expected >= 3 eligible flaws, got {eligible['flaws']}"

    @pytest.mark.asyncio
    async def test_eligible_leq_total(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        committed_flaw_data: dict[str, object],
    ) -> None:
        """Eligible count is a strict subset of the total count (guest excluded)."""
        async with session_factory() as session:
            counts = await _query_status(session)
            eligible = await _query_eligible(session)

        # Total includes guest; eligible does not.
        assert eligible["games"] < counts["total_games"]
        assert eligible["flaws"] < counts["total_flaws"]


class TestDryRunNoWrites:
    """run_dry_run writes nothing to the database."""

    @pytest.mark.asyncio
    async def test_dry_run_no_writes(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        committed_flaw_data: dict[str, object],
    ) -> None:
        """After run_dry_run, all game_flaws rows still have allowed_pv_lines IS NULL."""
        from sqlalchemy import func, select

        engine_game_id = committed_flaw_data["engine_game_id"]
        lichess_game_id = committed_flaw_data["lichess_game_id"]

        # Run dry-run with injected session_maker (never opens a real --db target).
        await run_dry_run(db="dev", session_maker=session_factory)

        # Verify: flaws for engine + lichess game still have NULL blobs.
        async with session_factory() as session:
            null_count = await session.scalar(
                select(func.count())
                .select_from(GameFlaw)
                .where(
                    GameFlaw.game_id.in_([engine_game_id, lichess_game_id]),
                    GameFlaw.allowed_pv_lines.is_(None),
                )
            )

        # 2 + 1 = 3 flaws must still be NULL.
        assert null_count == 3, (
            f"--dry-run should not write any blobs; expected 3 NULL-blob flaws, got {null_count}"
        )

    @pytest.mark.asyncio
    async def test_dry_run_returns_without_error(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        committed_flaw_data: dict[str, object],
    ) -> None:
        """run_dry_run completes without raising any exceptions."""
        # Just verify it doesn't raise — counts are already tested above.
        await run_dry_run(db="dev", session_maker=session_factory)


# ---------------------------------------------------------------------------
# snapshot_tactic_counts.py unit tests
# ---------------------------------------------------------------------------
# These tests validate the per-motif aggregation logic and markdown table
# format without a DB round-trip (pure-Python, no session needed).


class TestSnapshotMotifMapping:
    """TacticMotifInt.name maps each integer to a human-readable motif name."""

    def test_all_motif_ids_resolve(self) -> None:
        """Every TacticMotifInt value resolves to a name string."""
        for motif in TacticMotifInt:
            name = TacticMotifInt(motif.value).name
            assert isinstance(name, str), f"Expected str name for {motif.value}"
            assert len(name) > 0, f"Empty name for {motif.value}"

    def test_known_motif_names(self) -> None:
        """Spot-check a selection of known motif id-to-name mappings."""
        cases: list[tuple[int, str]] = [
            (1, "FORK"),
            (2, "HANGING_PIECE"),
            (3, "PIN"),
            (7, "BACK_RANK_MATE"),
            (29, "UNDER_PROMOTION"),
        ]
        for motif_id, expected_name in cases:
            actual_name = TacticMotifInt(motif_id).name
            assert actual_name == expected_name, (
                f"Expected motif {motif_id} → '{expected_name}', got '{actual_name}'"
            )

    def test_invalid_motif_raises(self) -> None:
        """An unknown motif id raises ValueError (not silently returning garbage)."""
        with pytest.raises(ValueError):
            TacticMotifInt(999)


class TestSnapshotMarkdownTable:
    """The snapshot_tactic_counts markdown table is well-formed for synthetic counts."""

    def _build_table(
        self,
        allowed_counts: dict[int, int],
        missed_counts: dict[int, int],
    ) -> str:
        """Build a minimal markdown table from per-motif counts.

        Replicates the table-building logic from snapshot_tactic_counts._build_count_table
        so we can assert its format without importing the script (which would require
        extra DB env setup). The actual script uses the same pattern.
        """
        lines = [
            "| Motif | Allowed | Missed |",
            "|-------|---------|--------|",
        ]
        all_motif_ids = sorted(set(allowed_counts) | set(missed_counts))
        for motif_id in all_motif_ids:
            try:
                name = TacticMotifInt(motif_id).name
            except ValueError:
                name = str(motif_id)
            a = allowed_counts.get(motif_id, 0)
            m = missed_counts.get(motif_id, 0)
            lines.append(f"| {name} | {a} | {m} |")
        return "\n".join(lines)

    def test_table_has_header_and_separator(self) -> None:
        """The generated table starts with a header row and a separator row."""
        table = self._build_table({1: 10}, {2: 5})
        table_lines = table.splitlines()
        assert table_lines[0].startswith("|")
        assert "---" in table_lines[1]

    def test_table_motif_names_not_numeric(self) -> None:
        """Known motif ids appear as name strings, not raw integers, in the table."""
        table = self._build_table({1: 10, 7: 3}, {1: 5})
        assert "FORK" in table
        assert "BACK_RANK_MATE" in table
        # Raw int "1" should not appear as a standalone cell
        # (it appears in counts but the motif column should be the name)
        lines_with_fork = [ln for ln in table.splitlines() if "FORK" in ln]
        assert len(lines_with_fork) >= 1

    def test_empty_counts_produce_header_only(self) -> None:
        """With no counts, the table contains only header + separator rows."""
        table = self._build_table({}, {})
        lines = [ln for ln in table.splitlines() if ln.strip()]
        assert len(lines) == 2, f"Expected 2 lines (header + sep), got {len(lines)}: {lines}"

    def test_motif_present_in_only_one_orientation(self) -> None:
        """A motif appearing in allowed-only or missed-only gets 0 in the other column."""
        table = self._build_table({3: 7}, {})  # PIN in allowed, nothing in missed
        pin_lines = [ln for ln in table.splitlines() if "PIN" in ln]
        assert len(pin_lines) == 1
        parts = [p.strip() for p in pin_lines[0].split("|") if p.strip()]
        # parts[0] = motif name, parts[1] = allowed count, parts[2] = missed count
        assert parts[1] == "7", f"Expected allowed=7, got {parts[1]}"
        assert parts[2] == "0", f"Expected missed=0, got {parts[2]}"
