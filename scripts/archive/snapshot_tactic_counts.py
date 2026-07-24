"""Snapshot per-motif tactic chip counts before/after the Phase 145 blob backfill (SC3).

Queries the per-motif allowed/missed chip counts from game_flaws and writes a section
into reports/retag/rollout-YYYY-MM-DD.md.  Run --phase before before enabling the
tier-4 lottery on prod, and --phase after once the drain is substantially complete.
The two sections are appended to the same dated file so the before/after comparison
is self-contained.

Queries (read-only):
    SELECT allowed_tactic_motif, COUNT(*) FROM game_flaws
    WHERE allowed_tactic_motif IS NOT NULL GROUP BY 1

    SELECT missed_tactic_motif, COUNT(*) FROM game_flaws
    WHERE missed_tactic_motif IS NOT NULL GROUP BY 1

Both motif ids are decoded to TacticMotifInt names in the output table.  The delta
column (after minus before) is computed and appended when writing the "after" section.
The script never writes to the DB (no INSERT/UPDATE).

DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

Usage
-----
    # Before enabling EVAL_AUTO_DRAIN_ENABLED=true:
    uv run python scripts/snapshot_tactic_counts.py --db prod --phase before

    # After drain is substantially complete:
    uv run python scripts/snapshot_tactic_counts.py --db prod --phase after

    # Dev smoke-test:
    uv run python scripts/snapshot_tactic_counts.py --db dev --phase before
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target  # noqa: E402
from app.models.game_flaw import GameFlaw  # noqa: E402
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401 (registers FK table)
from app.models.user import User  # noqa: E402, F401 (registers FK table)
from app.services.tactic_detector import TacticMotifInt  # noqa: E402

# Default report directory: reports/retag/ committed under the project root.
_DEFAULT_REPORT_DIR = Path(__file__).resolve().parent.parent / "reports" / "retag"

# Sentinel pattern used to find the "before" block inside the report file
# so _write_after_section can extract its counts for the delta column.
_BEFORE_ALLOWED_MARKER = "<!-- snapshot:before:allowed -->"
_BEFORE_MISSED_MARKER = "<!-- snapshot:before:missed -->"

# Type alias for the injectable session factory.
SessionMaker = async_sessionmaker[AsyncSession]

Phase = Literal["before", "after"]


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description=(
            "Snapshot per-motif tactic chip counts for the Phase 145 rollout (SC3). "
            "Writes/appends to reports/retag/rollout-YYYY-MM-DD.md. Read-only DB access."
        )
    )
    parser.add_argument(
        "--db",
        choices=["dev", "benchmark", "prod"],
        required=True,
        help="DB target: dev (localhost:5432), benchmark (localhost:5433), prod (SSH tunnel).",
    )
    parser.add_argument(
        "--phase",
        choices=["before", "after"],
        required=True,
        help=(
            "'before': write the pre-drain baseline. "
            "'after': append the post-drain table with a delta column. "
            "Both phases append to the same dated file."
        ),
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Per-motif count query (read-only)
# ---------------------------------------------------------------------------


async def _query_motif_counts(session: AsyncSession) -> tuple[dict[int, int], dict[int, int]]:
    """Return per-motif allowed and missed tactic chip counts.

    Queries game_flaws for non-NULL allowed_tactic_motif and missed_tactic_motif
    values, grouped by motif id.  Returns two dicts mapping motif_id → count.

    Args:
        session: Read-only session bound to the target DB.

    Returns:
        (allowed_counts, missed_counts) where each is {motif_int_id: count}.
    """
    # Allowed orientation counts.
    allowed_rows = (
        await session.execute(
            sa.select(GameFlaw.allowed_tactic_motif, sa.func.count().label("cnt"))
            .where(GameFlaw.allowed_tactic_motif.isnot(None))
            .group_by(GameFlaw.allowed_tactic_motif)
            .order_by(GameFlaw.allowed_tactic_motif)
        )
    ).all()

    # Missed orientation counts.
    missed_rows = (
        await session.execute(
            sa.select(GameFlaw.missed_tactic_motif, sa.func.count().label("cnt"))
            .where(GameFlaw.missed_tactic_motif.isnot(None))
            .group_by(GameFlaw.missed_tactic_motif)
            .order_by(GameFlaw.missed_tactic_motif)
        )
    ).all()

    allowed_counts: dict[int, int] = {row.allowed_tactic_motif: row.cnt for row in allowed_rows}
    missed_counts: dict[int, int] = {row.missed_tactic_motif: row.cnt for row in missed_rows}
    return allowed_counts, missed_counts


# ---------------------------------------------------------------------------
# Markdown table helpers
# ---------------------------------------------------------------------------


def _motif_name(motif_id: int) -> str:
    """Decode a TacticMotifInt id to its name; fall back to the raw int as a string."""
    try:
        return TacticMotifInt(motif_id).name
    except ValueError:
        return str(motif_id)


def _build_count_table(
    allowed_counts: dict[int, int],
    missed_counts: dict[int, int],
    before_allowed: dict[int, int] | None = None,
    before_missed: dict[int, int] | None = None,
) -> str:
    """Build a per-motif markdown table from allowed/missed chip counts.

    When before_allowed/before_missed are provided (i.e. --phase after), a delta
    column is added showing (after - before) for each orientation.

    Args:
        allowed_counts: Current per-motif allowed chip counts.
        missed_counts: Current per-motif missed chip counts.
        before_allowed: Pre-drain allowed counts for the delta column (after phase only).
        before_missed: Pre-drain missed counts for the delta column (after phase only).

    Returns:
        Markdown pipe-table string (no trailing newline).
    """
    show_delta = before_allowed is not None and before_missed is not None
    all_motif_ids = sorted(set(allowed_counts) | set(missed_counts))
    if show_delta:
        # Merge ids from before counts too so rows only in "before" appear as delta.
        all_motif_ids = sorted(
            set(all_motif_ids) | set(before_allowed or {}) | set(before_missed or {})
        )

    if not all_motif_ids:
        return "_No tactic-tagged flaws found in this scope._"

    if show_delta:
        header = "| Motif | Allowed | Missed | Allowed delta | Missed delta |"
        sep = "|-------|---------|--------|---------------|--------------|"
    else:
        header = "| Motif | Allowed | Missed |"
        sep = "|-------|---------|--------|"

    lines = [header, sep]
    for motif_id in all_motif_ids:
        name = _motif_name(motif_id)
        a = allowed_counts.get(motif_id, 0)
        m = missed_counts.get(motif_id, 0)
        if show_delta:
            ba = (before_allowed or {}).get(motif_id, 0)
            bm = (before_missed or {}).get(motif_id, 0)
            da = f"{a - ba:+d}"
            dm = f"{m - bm:+d}"
            lines.append(f"| {name} | {a} | {m} | {da} | {dm} |")
        else:
            lines.append(f"| {name} | {a} | {m} |")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Report file helpers
# ---------------------------------------------------------------------------


def _parse_before_counts_from_report(report_text: str, marker: str) -> dict[int, int]:
    """Extract per-motif counts from the "before" section of an existing report file.

    The "before" section embeds counts in an HTML comment block:
        <!-- snapshot:before:allowed -->
        1=123,2=456,...
        <!-- /snapshot -->

    Returns an empty dict if the marker is not found or the format is unexpected.
    """
    pattern = re.compile(
        re.escape(marker) + r"\n([^\n]*)\n<!-- /snapshot -->",
        re.MULTILINE,
    )
    m = pattern.search(report_text)
    if not m:
        return {}
    raw = m.group(1).strip()
    if not raw:
        return {}
    result: dict[int, int] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" not in pair:
            continue
        k, v = pair.split("=", 1)
        try:
            result[int(k)] = int(v)
        except ValueError:
            continue
    return result


def _encode_counts(counts: dict[int, int]) -> str:
    """Encode per-motif counts as a compact key=value CSV for embedding in comments."""
    return ",".join(f"{k}={v}" for k, v in sorted(counts.items()))


def _write_before_section(
    report_path: Path,
    ts_str: str,
    db: str,
    allowed_counts: dict[int, int],
    missed_counts: dict[int, int],
) -> None:
    """Write or overwrite the 'before' section of the rollout report.

    Embeds machine-readable counts in HTML comments so _write_after_section
    can parse them without a DB round-trip.
    """
    table = _build_count_table(allowed_counts, missed_counts)
    allowed_encoded = _encode_counts(allowed_counts)
    missed_encoded = _encode_counts(missed_counts)

    total_allowed = sum(allowed_counts.values())
    total_missed = sum(missed_counts.values())

    content = f"""# Phase 145 Rollout: Tactic Chip Counts

**Generated:** {ts_str}
**DB target:** {db}

## Before rollout (baseline)

Snapshot taken before enabling the tier-4 MultiPV=2 blob-backfill lottery.

**Total allowed-tagged flaws:** {total_allowed:,}
**Total missed-tagged flaws:** {total_missed:,}

{table}

{_BEFORE_ALLOWED_MARKER}
{allowed_encoded}
<!-- /snapshot -->
{_BEFORE_MISSED_MARKER}
{missed_encoded}
<!-- /snapshot -->
"""
    report_path.write_text(content)


def _write_after_section(
    report_path: Path,
    ts_str: str,
    db: str,
    allowed_counts: dict[int, int],
    missed_counts: dict[int, int],
) -> None:
    """Append the 'after' section to the rollout report.

    Reads the 'before' counts from the existing file (via embedded comments)
    and adds a delta column to the after table.  Falls back to no-delta if
    the before section cannot be found (e.g. run out-of-order).
    """
    before_text = report_path.read_text() if report_path.exists() else ""
    before_allowed = _parse_before_counts_from_report(before_text, _BEFORE_ALLOWED_MARKER)
    before_missed = _parse_before_counts_from_report(before_text, _BEFORE_MISSED_MARKER)

    has_before = bool(before_allowed or before_missed)
    table = _build_count_table(
        allowed_counts,
        missed_counts,
        before_allowed if has_before else None,
        before_missed if has_before else None,
    )

    total_allowed = sum(allowed_counts.values())
    total_missed = sum(missed_counts.values())

    delta_note = (
        "Delta column shows (after - before). Positive = more flaws now carry this motif tag."
        if has_before
        else "(No 'before' baseline found in this file — delta column omitted.)"
    )

    after_section = f"""
## After rollout

Snapshot taken after the tier-4 MultiPV=2 blob-backfill lottery has drained substantially.

**Generated:** {ts_str}
**DB target:** {db}
**Total allowed-tagged flaws:** {total_allowed:,}
**Total missed-tagged flaws:** {total_missed:,}

{delta_note}

{table}
"""
    with report_path.open("a") as f:
        f.write(after_section)


# ---------------------------------------------------------------------------
# Top-level runner
# ---------------------------------------------------------------------------


async def run_snapshot(
    *,
    db: str,
    phase: Phase,
    session_maker: SessionMaker | None = None,
    report_dir: Path | None = None,
) -> None:
    """Query per-motif counts and write/append to the rollout report.

    Read-only: no DB writes.  Creates reports/retag/ if it does not exist.

    Args:
        db: DB target ("dev", "benchmark", or "prod").
        phase: "before" writes the baseline; "after" appends with a delta column.
        session_maker: Injectable session factory for tests.  When None, created
            from db_url_for_target(db).
        report_dir: Output directory for the report.  Defaults to reports/retag/.
            Tests inject a tmp_path to avoid polluting the version-controlled tree.
    """
    if session_maker is None:
        url = db_url_for_target(db)
        engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(engine, expire_on_commit=False)

    _log(f"Target DB: {db}")
    _log(f"Phase: --phase {phase}")
    _log("Querying per-motif tactic chip counts (read-only) ...")
    _log("")

    async with session_maker() as session:
        allowed_counts, missed_counts = await _query_motif_counts(session)

    _log(
        f"  Allowed-tagged motifs : {len(allowed_counts)} distinct motifs, {sum(allowed_counts.values()):,} flaws"
    )
    _log(
        f"  Missed-tagged motifs  : {len(missed_counts)} distinct motifs, {sum(missed_counts.values()):,} flaws"
    )

    if report_dir is None:
        report_dir = _DEFAULT_REPORT_DIR
    report_dir.mkdir(parents=True, exist_ok=True)

    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ts_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    report_path = report_dir / f"rollout-{date_str}.md"

    if phase == "before":
        _write_before_section(report_path, ts_str, db, allowed_counts, missed_counts)
    else:
        _write_after_section(report_path, ts_str, db, allowed_counts, missed_counts)

    _log("")
    _log(f"Report {'written' if phase == 'before' else 'appended'} to {report_path}")
    _log(
        "Commit with: git add reports/retag/ && git commit -m "
        f'"docs: snapshot tactic counts --phase {phase} ({db})"'
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _main() -> None:
    args = _parse_args()
    asyncio.run(run_snapshot(db=args.db, phase=args.phase))


if __name__ == "__main__":
    _main()
