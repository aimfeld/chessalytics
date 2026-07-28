"""Reset one user's Train state so a schedule test can start from a clean slate.

WHY THIS EXISTS
    ``app/core/dev_clock.py`` lets local dev shift the clock the Train
    endpoints compute against, so the calendar-shaped behaviour (weekday mask,
    session expiry, the spaced-repetition due-date ladder, Mon-start streak
    weeks) can be exercised in one sitting instead of over real days. The
    catch: rows written while the clock is shifted persist with the SHIFTED
    dates. Travel a month forward, solve a few sessions, then reset the
    offset, and the user is left with drill items due in the future and a
    streak snapshot settled past today. This wipes that back to zero.

WHAT IT DELETES / RESETS (for ONE user)
    - ``drill_solves``  — deleted (cascades from drill_sessions anyway; deleted
      explicitly so the counts printed are honest).
    - ``drill_sessions`` — deleted.
    - ``drill_items``   — deleted. The pool is re-materialised from the user's
      own qualifying blunders on the next ``POST /train/sessions``, so this
      loses only spaced-repetition progress, never game/flaw data.
    - ``train_settings`` — the D-18 streak snapshot columns
      (``streak_count``, ``flame_state``, ``streak_settled_through``) reset to
      0/NULL/NULL. ``timezone``/``weekday_mask``/``puzzles_per_session`` are
      DELIBERATELY kept: they are the schedule under test, and re-picking them
      in the UI after every reset would be pure friction. Pass
      ``--reset-settings`` to drop the row entirely and get the D-06/D-07/D-08
      defaults back on next touch.

    Nothing outside these four tables is touched — no games, positions, flaws,
    or evals.

DB target (per CLAUDE.md), selected with ``--db``:
    dev:       localhost:5432  (flawchess-dev Docker compose) — the intended target
    benchmark: localhost:5433
    prod:      REFUSED. This is destructive per-user state; there is no
               legitimate reason to run it against production.

Usage:
    # Show what would be deleted, touch nothing:
    uv run python scripts/reset_train_state.py --user-id 1 --dry-run

    # Reset Train progress, keep the schedule settings:
    uv run python scripts/reset_train_state.py --user-id 1

    # Also drop the settings row (back to first-touch defaults):
    uv run python scripts/reset_train_state.py --user-id 1 --reset-settings
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target  # noqa: E402
from app.models.drill_item import DrillItem  # noqa: E402
from app.models.drill_session import DrillSession  # noqa: E402
from app.models.drill_solve import DrillSolve  # noqa: E402
from app.models.train_settings import TrainSettings  # noqa: E402

# Importing ANY `app.models.*` submodule executes `app/models/__init__.py`,
# which registers `Game`/`GamePosition` (a relationship() pair) but NOT `User`.
# The first ORM-level delete()/update() below forces a full
# configure_mappers(), which then trips over `games.user_id`'s FK to a `users`
# table that is absent from the metadata (NoReferencedTableError). Registering
# User (and OAuthAccount, which User.oauth_accounts resolves by name) closes
# the gap. Unused at runtime — imported for the side effect only.
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.models.user import User  # noqa: E402, F401

# Deliberately excludes "prod" — see the module docstring.
ALLOWED_DB_TARGETS = ("dev", "benchmark")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reset one user's Train (drill) state for local schedule testing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--user-id", type=int, required=True, help="Numeric users.id to reset.")
    parser.add_argument(
        "--db",
        choices=ALLOWED_DB_TARGETS,
        default="dev",
        help="DB target (default: dev). Production is intentionally not selectable.",
    )
    parser.add_argument(
        "--reset-settings",
        action="store_true",
        help="Also delete the train_settings row (timezone/weekday mask/session size "
        "return to first-touch defaults). Without this, only the streak snapshot resets.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report the row counts that WOULD be affected, then exit without writing.",
    )
    return parser.parse_args()


async def _count_rows(session: AsyncSession, user_id: int) -> dict[str, int]:
    """Return the current per-table Train row counts for one user."""
    counts: dict[str, int] = {}
    counts["drill_items"] = (
        await session.execute(
            select(func.count()).select_from(DrillItem).where(DrillItem.user_id == user_id)
        )
    ).scalar_one()
    counts["drill_sessions"] = (
        await session.execute(
            select(func.count()).select_from(DrillSession).where(DrillSession.user_id == user_id)
        )
    ).scalar_one()
    counts["drill_solves"] = (
        await session.execute(
            select(func.count()).select_from(DrillSolve).where(DrillSolve.user_id == user_id)
        )
    ).scalar_one()
    counts["train_settings"] = (
        await session.execute(
            select(func.count()).select_from(TrainSettings).where(TrainSettings.user_id == user_id)
        )
    ).scalar_one()
    return counts


async def _reset(session: AsyncSession, user_id: int, *, reset_settings: bool) -> None:
    """Delete the user's drill state and clear (or drop) their settings row."""
    await session.execute(delete(DrillSolve).where(DrillSolve.user_id == user_id))
    await session.execute(delete(DrillSession).where(DrillSession.user_id == user_id))
    await session.execute(delete(DrillItem).where(DrillItem.user_id == user_id))
    if reset_settings:
        await session.execute(delete(TrainSettings).where(TrainSettings.user_id == user_id))
    else:
        await session.execute(
            update(TrainSettings)
            .where(TrainSettings.user_id == user_id)
            .values(streak_count=0, flame_state=None, streak_settled_through=None)
        )


async def main() -> int:
    args = _parse_args()
    engine = create_async_engine(db_url_for_target(args.db), pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as session:
            before = await _count_rows(session, args.user_id)
            print(f"Train state for user {args.user_id} on --db {args.db}:")
            for table, count in before.items():
                print(f"  {table:<16} {count}")
            if args.dry_run:
                print("\n--dry-run: nothing written.")
                return 0
            if sum(before.values()) == 0:
                print("\nNothing to reset.")
                return 0
            await _reset(session, args.user_id, reset_settings=args.reset_settings)
            await session.commit()
            after = await _count_rows(session, args.user_id)
            settings_note = "deleted" if args.reset_settings else "streak snapshot cleared"
            print(f"\nReset done (train_settings: {settings_note}). Remaining rows:")
            for table, count in after.items():
                print(f"  {table:<16} {count}")
    finally:
        await engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
