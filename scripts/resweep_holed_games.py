"""Re-arm already-stamped engine games with non-terminal eval holes (Phase 119 SEED-045).

Still load-bearing, not legacy: a weak/slow remote worker can recreate this
holed-stamped population go-forward (see resweep_holed_games's docstring in
app/services/eval_drain.py for the Path-C mechanism), so there is no
population-exhaustion date for this tool.

Finds engine games (lichess_evals_at IS NULL) whose full_evals_completed_at is set
but that still carry at least one non-terminal hole (eval_cp IS NULL AND eval_mate IS NULL
on a ply that is not the terminal game-over ply). Clears their completion markers
(full_evals_completed_at, full_pv_completed_at) and resets full_eval_attempts to 0
so the bounded-retry drain re-picks them with a fresh MAX_EVAL_ATTEMPTS budget.

The --db target is REQUIRED so this never silently runs against the wrong database.
dev=localhost:5432, benchmark=localhost:5433, prod=localhost:15432 (via bin/prod_db_tunnel.sh).

Usage:
    uv run python scripts/resweep_holed_games.py --db prod --dry-run   # count only
    uv run python scripts/resweep_holed_games.py --db prod             # sweep all
    uv run python scripts/resweep_holed_games.py --db dev --limit 100  # sweep first 100
"""

import argparse
import asyncio
import sys
from pathlib import Path

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.core.config import db_url_for_target  # noqa: E402

# Import every ORM model so the SQLAlchemy registry fully configures. The resweep
# query uses ORM entities (Game/GamePosition), which forces a global mapper-configure
# pass; User.oauth_accounts → OAuthAccount must be registered or that pass fails. The
# app registers these via FastAPI-Users setup at startup; a bare script must do it here.
import app.models.oauth_account  # noqa: E402, F401
import app.models.user  # noqa: E402, F401


async def _main(db: str, dry_run: bool, limit: int | None) -> int:
    from app.services.eval_drain import resweep_holed_games

    # Build a sessionmaker bound to the chosen target rather than the app's default
    # async_session_maker (which binds to DATABASE_URL = the dev DB locally). Without
    # this, --db prod would silently hit dev (eval_drain uses the module global).
    engine = create_async_engine(db_url_for_target(db), pool_pre_ping=True)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        print(f"Target: {engine.url.host}:{engine.url.port}/{engine.url.database} ({db})")
        count = await resweep_holed_games(limit=limit, dry_run=dry_run, session_maker=session_maker)
        action = "Would re-arm" if dry_run else "Re-armed"
        print(f"{action} {count} game(s) with non-terminal eval holes.")
        return count
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Re-arm engine games with non-terminal eval holes for the bounded-retry drain."
    )
    parser.add_argument(
        "--db",
        choices=["dev", "benchmark", "prod"],
        required=True,
        help=(
            "Database target.  dev=localhost:5432, benchmark=localhost:5433, "
            "prod=localhost:15432 (via bin/prod_db_tunnel.sh).  REQUIRED."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Count candidates without updating (default: False).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Cap the scan at N games (default: all).",
    )
    args = parser.parse_args()
    asyncio.run(_main(db=args.db, dry_run=args.dry_run, limit=args.limit))


if __name__ == "__main__":
    main()
