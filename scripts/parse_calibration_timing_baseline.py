"""parse_calibration_timing_baseline.py — Phase 199 (D-08/A-02) pre-195
game-level wall-clock timing baseline parser.

Parses the harness's per-ply stdout timing lines out of a local `run.log`
(the `onPly` shape `calibration-harness.mjs` has always emitted —
`[calibration-harness]   ply N (bot|anchor) UCI took X.XXs`; 199-01 kept this
line byte-identical for exactly this reason, see 199-01-SUMMARY.md) and
attributes each segment of consecutive plies to a `(bot_elo, bot_blend)` cell
using the sibling committed raw ledger TSV in the same out-dir. The log lines
carry no cell marker at all — attribution comes entirely from the ledger's
`bot_elo`/`bot_blend`/`game_index`/`plies` columns, joined in file order.

This is a standalone research tool (`scripts/`, not `app/`) — stdlib only
(`argparse`/`csv`/`json`/`re`/`pathlib`/`dataclasses`), no numpy/scipy, no
Sentry capture (CLAUDE.md Sentry rules apply to app/services and
app/routers only).

Refuses (raises) rather than silently mis-measuring:
  - a log or ledger using the retired `maia900` anchor token, or a ledger
    blend value outside the current preset blends {0, 0.05, 0.5} — the
    2026-07-12 clamped-run incident's anchor scale (199-CONTEXT.md A-02,
    Pitfall 3), which must never contaminate this baseline
  - a ply segment whose length does not match its ledger row's recorded
    `plies` count — a slipped join would silently attribute an entire
    cell's timings to its neighbour, exactly the failure this baseline
    cannot survive

Usage (fixture self-test, run before ever pointing this at real logs):
    uv run python scripts/parse_calibration_timing_baseline.py --self-test

Usage (real run, one out-dir):
    uv run python scripts/parse_calibration_timing_baseline.py \\
        --out-dir reports/data/sweep-human
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent

# The harness's own per-ply stdout shape (calibration-harness.mjs's onPly
# callback inside playCellAnchorGames) — the parser's only input format.
# Declared once, referenced everywhere below (never inlined at a call site).
PLY_TIMING_RE = re.compile(
    r"^\[calibration-harness\]\s+ply\s+(\d+)\s+\((bot|anchor)\)\s+\S+\s+took\s+([\d.]+)s$"
)

MOVER_BOT = "bot"
MOVER_ANCHOR = "anchor"

# Retired 2026-07-12 clamped-run incident anchor scale
# (calibration-bot-cell-schedule.mjs header, lines 9-18) — a log or ledger
# carrying this token predates the current Phase-173/180 anchor ladder and
# must never contaminate this baseline.
RETIRED_ANCHOR_TOKENS = frozenset({"maia900"})

# Current preset blends (frontend/src/lib/playStyle.ts: HUMAN_BLEND=0,
# LIGHT_BLEND=0.05, DEEP_BLEND=0.5). A ledger blend outside this set is
# also a 2026-07-12-incident symptom (that scheme used blends {0, 0.5, 1}).
CURRENT_PRESET_BLENDS = frozenset({0.0, 0.05, 0.5})

# The raw per-game ledger sits alongside two derived siblings in the same
# out-dir; only the raw one (no suffix) carries per-game plies/game_index.
_RAW_LEDGER_EXCLUDED_SUFFIXES = ("-cells.tsv", "-summary.tsv")


@dataclass(frozen=True)
class PlyRecord:
    """One parsed per-ply timing line."""

    ply: int
    mover: str
    seconds: float


@dataclass(frozen=True)
class LedgerRow:
    """The columns of one raw-ledger row this parser needs for attribution."""

    bot_elo: int
    bot_blend: float
    anchor: str
    plies: int
    game_index: int


@dataclass
class CellAggregate:
    """Running per-(bot_elo, bot_blend) timing accumulator."""

    game_count: int = 0
    ply_count: int = 0
    total_elapsed_ms: float = 0.0
    bot_move_ms_sum: float = 0.0
    bot_move_count: int = 0

    def as_dict(self) -> dict[str, float | int]:
        mean_game_elapsed_ms = self.total_elapsed_ms / self.game_count if self.game_count else 0.0
        mean_bot_move_ms = (
            self.bot_move_ms_sum / self.bot_move_count if self.bot_move_count else 0.0
        )
        return {
            "game_count": self.game_count,
            "ply_count": self.ply_count,
            "total_elapsed_ms": round(self.total_elapsed_ms, 1),
            "mean_game_elapsed_ms": round(mean_game_elapsed_ms, 1),
            "mean_bot_move_ms": round(mean_bot_move_ms, 1),
        }


def parse_ply_line(line: str) -> PlyRecord | None:
    """Matches PLY_TIMING_RE against one raw log line. Returns None (never
    raises) for anything that is not a per-ply timing line — the loading
    banner, the per-game marker line, result lines, blank lines, or genuine
    garbage from an unrelated log stream. The caller counts the Nones."""
    match = PLY_TIMING_RE.match(line.rstrip("\r\n"))
    if match is None:
        return None
    ply_str, mover, seconds_str = match.groups()
    return PlyRecord(ply=int(ply_str), mover=mover, seconds=float(seconds_str))


def read_ply_records(log_path: Path) -> tuple[list[PlyRecord], int]:
    """Reads every line of log_path, returns (matched ply records in file
    order, count of lines that did not match). Raises immediately if any
    line carries a retired anchor token (Pitfall 3) — a defensive scan on
    top of the authoritative ledger-side check in load_ledger_rows."""
    records: list[PlyRecord] = []
    skipped = 0
    with log_path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            for token in RETIRED_ANCHOR_TOKENS:
                if token in line:
                    raise ValueError(
                        f"{log_path} contains the retired {token!r} anchor token — this is "
                        "the 2026-07-12 clamped-run incident's anchor scale, not the current "
                        "Phase-173/180 scale. Refusing to parse."
                    )
            record = parse_ply_line(line)
            if record is None:
                skipped += 1
            else:
                records.append(record)
    return records, skipped


def segment_games(records: list[PlyRecord]) -> list[list[PlyRecord]]:
    """Splits an in-order list of ply records into per-game segments. A new
    game starts whenever the ply number does not strictly increase from the
    previous record — the harness always numbers plies 1..N within a game
    and resets to 1 for the next one."""
    segments: list[list[PlyRecord]] = []
    current: list[PlyRecord] = []
    previous_ply = 0
    for record in records:
        if current and record.ply <= previous_ply:
            segments.append(current)
            current = []
        current.append(record)
        previous_ply = record.ply
    if current:
        segments.append(current)
    return segments


def load_ledger_rows(ledger_path: Path) -> list[LedgerRow]:
    """Loads the sibling committed raw ledger TSV, in file order (which is
    also game-play order — the harness streams one row per game as it
    finishes, never reorders). Raises if any row uses the retired anchor
    scale or a blend outside the current preset blends."""
    rows: list[LedgerRow] = []
    with ledger_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for raw in reader:
            anchor = raw["anchor"]
            blend = float(raw["bot_blend"])
            if anchor in RETIRED_ANCHOR_TOKENS or blend not in CURRENT_PRESET_BLENDS:
                raise ValueError(
                    f"{ledger_path} uses a retired anchor scale (anchor={anchor!r}, "
                    f"blend={blend!r}) — this is the 2026-07-12 clamped-run incident's "
                    "scheme (maia900 anchor / {0, 0.5, 1} blends), not the current "
                    "Phase-173/180 scale. Refusing to parse."
                )
            rows.append(
                LedgerRow(
                    bot_elo=int(raw["bot_elo"]),
                    bot_blend=blend,
                    anchor=anchor,
                    plies=int(raw["plies"]),
                    game_index=int(raw["game_index"]),
                )
            )
    return rows


# A crash-orphaned segment is always STRICTLY SHORTER than its game's full
# recorded ply count: a supervised process crashes mid-game (its plies
# already flushed to run.log by onPly), then the supervisor resumes it and
# the harness replays that SAME game_index from scratch (deterministic
# seeding, WR-01) — see reports/data/sweep-{light,deep}/supervisor.log's
# crash-restart history, confirmed against these exact files: 4 orphans
# each, every one shorter than its ledger row's plies, zero genuine
# mismatches. This bounds how many consecutive shorter segments are
# tolerated before treating it as a genuine structural anomaly instead.
MAX_CONSECUTIVE_ORPHAN_SKIPS = 25


def _advance_past_orphans(
    segments: list[list[PlyRecord]], seg_idx: int, row: LedgerRow, log_path: Path
) -> tuple[int, int, int]:
    """Advances seg_idx past any crash-orphaned segments preceding the one
    that matches `row`'s recorded ply count. Returns (the matching segment's
    index, orphan segments skipped, orphan plies skipped). Raises if no
    matching segment turns up within MAX_CONSECUTIVE_ORPHAN_SKIPS attempts,
    or if the next segment is as long as or longer than expected yet still
    unequal — that is not a truncation, so not safely discardable, and a
    slipped join here would silently corrupt the timing baseline."""
    orphan_segments = 0
    orphan_plies = 0
    while True:
        if seg_idx >= len(segments):
            raise ValueError(
                f"{log_path}: ran out of ply-segments before matching ledger "
                f"game_index={row.game_index} (plies={row.plies}) — refusing to attribute."
            )
        segment = segments[seg_idx]
        if len(segment) == row.plies:
            return seg_idx, orphan_segments, orphan_plies
        if len(segment) >= row.plies or orphan_segments >= MAX_CONSECUTIVE_ORPHAN_SKIPS:
            raise ValueError(
                f"{log_path}: game_index={row.game_index} ledger records plies={row.plies} "
                f"but the next log segment has {len(segment)} plies — refusing to attribute "
                "(a slipped join would silently corrupt the timing baseline)."
            )
        orphan_segments += 1
        orphan_plies += len(segment)
        seg_idx += 1


def _fold_segment_into_cell(
    cells: dict[tuple[int, float], CellAggregate], row: LedgerRow, segment: list[PlyRecord]
) -> None:
    key = (row.bot_elo, row.bot_blend)
    agg = cells.setdefault(key, CellAggregate())
    agg.game_count += 1
    agg.ply_count += len(segment)
    agg.total_elapsed_ms += sum(p.seconds for p in segment) * 1000.0
    for p in segment:
        if p.mover == MOVER_BOT:
            agg.bot_move_ms_sum += p.seconds * 1000.0
            agg.bot_move_count += 1


def _attribute_and_aggregate(
    segments: list[list[PlyRecord]], ledger_rows: list[LedgerRow], log_path: Path
) -> tuple[dict[tuple[int, float], CellAggregate], int, int]:
    """Joins ply-segments to ledger rows in order, tolerating crash-orphaned
    partial-game segments (_advance_past_orphans) but raising rather than
    sliding the join by one game on any other mismatch — a slipped join
    would attribute an entire cell's timings to its neighbour. Returns
    (per-cell aggregates, total orphan segments skipped, total orphan plies
    skipped)."""
    cells: dict[tuple[int, float], CellAggregate] = {}
    seg_idx = 0
    total_orphan_segments = 0
    total_orphan_plies = 0
    for row in ledger_rows:
        seg_idx, orphan_segments, orphan_plies = _advance_past_orphans(
            segments, seg_idx, row, log_path
        )
        total_orphan_segments += orphan_segments
        total_orphan_plies += orphan_plies
        _fold_segment_into_cell(cells, row, segments[seg_idx])
        seg_idx += 1
    return cells, total_orphan_segments, total_orphan_plies


def parse_run_log(log_path: Path, ledger_path: Path) -> dict[str, object]:
    """Parses one harness run.log against its sibling raw ledger, returning
    per-(bot_elo, bot_blend) timing aggregates plus the skipped-line count
    and any crash-orphaned segments discarded along the way. Cell keys in
    the returned `cells` dict are (bot_elo, bot_blend) tuples."""
    records, skipped = read_ply_records(log_path)
    segments = segment_games(records)
    ledger_rows = load_ledger_rows(ledger_path)
    cells, orphan_segments, orphan_plies = _attribute_and_aggregate(segments, ledger_rows, log_path)
    return {
        "cells": {key: agg.as_dict() for key, agg in cells.items()},
        "skipped_line_count": skipped,
        "total_lines_matched": len(records),
        "orphan_segment_count": orphan_segments,
        "orphan_ply_count": orphan_plies,
    }


def find_ledger_path(out_dir: Path) -> Path:
    """Finds the single raw-ledger TSV in out_dir (excluding its -cells.tsv
    and -summary.tsv derived siblings)."""
    candidates = sorted(
        p
        for p in out_dir.glob("calibration-harness-*.tsv")
        if not p.name.endswith(_RAW_LEDGER_EXCLUDED_SUFFIXES)
    )
    if not candidates:
        raise FileNotFoundError(f"No raw ledger TSV found under {out_dir}")
    if len(candidates) > 1:
        raise ValueError(f"Multiple candidate raw ledgers under {out_dir}: {candidates}")
    return candidates[0]


def parse_run_log_dir(out_dir: Path) -> dict[str, object]:
    """Convenience wrapper: run.log + its auto-discovered sibling ledger,
    both read from the same sweep out-dir."""
    return parse_run_log(out_dir / "run.log", find_ledger_path(out_dir))


# --- --self-test: a small hardcoded fixture, the Python analog of .check.mjs ---

# Illustrative synthetic lines mirroring the harness's real stdout shape —
# NOT captured output — intermixed with the banner/marker/result line shapes
# a real run.log also contains, which the parser must skip without raising.
_SELF_TEST_LOG_LINES = [
    "[calibration-harness] loading Maia session + spawning a 4-process Stockfish pool...",
    "[calibration-harness] game 0 (locate): elo=1100 blend=0.0 anchor=sf0 "
    "opening=Test Opening botIsWhite=true",
    "[calibration-harness]   ply 1 (bot) e2e4 took 0.20s",
    "[calibration-harness]   ply 2 (anchor) e7e5 took 1.00s",
    "[calibration-harness]   ply 3 (bot) g1f3 took 0.25s",
    "    a garbage line from an unrelated log stream that must not raise",
    "[calibration-harness] result=draw reason=ply_cap_draw plies=3",
    "[calibration-harness] game 1 (locate): elo=1100 blend=0.0 anchor=sf0 "
    "opening=Test Opening 2 botIsWhite=false",
    "[calibration-harness]   ply 1 (anchor) d2d4 took 1.00s",
    "[calibration-harness]   ply 2 (bot) g8f6 took 0.30s",
    "[calibration-harness] result=draw reason=ply_cap_draw plies=2",
]

# A second fixture, mirroring the REAL crash-recovery artifact found in
# reports/data/sweep-{light,deep}/run.log: game_index 1's first attempt
# crashes after one ply (never gets a ledger row — see supervisor.log), the
# harness restarts and replays game_index 1 from scratch. The log therefore
# has 3 segments (game 0, the 1-ply orphan, the real game 1) but the ledger
# has only 2 rows.
_SELF_TEST_LOG_LINES_WITH_ORPHAN = [
    "[calibration-harness] loading Maia session + spawning a 4-process Stockfish pool...",
    "[calibration-harness] game 0 (locate): elo=1100 blend=0.0 anchor=sf0 "
    "opening=Test Opening botIsWhite=true",
    "[calibration-harness]   ply 1 (bot) e2e4 took 0.20s",
    "[calibration-harness]   ply 2 (anchor) e7e5 took 1.00s",
    "[calibration-harness]   ply 3 (bot) g1f3 took 0.25s",
    "[calibration-harness] result=draw reason=ply_cap_draw plies=3",
    "[calibration-harness] game 1 (locate): elo=1100 blend=0.0 anchor=sf0 "
    "opening=Orphaned crash game botIsWhite=true",
    "[calibration-harness]   ply 1 (bot) a2a3 took 0.15s",
    "[calibration-harness] loading Maia session + spawning a 4-process Stockfish pool...",
    "[calibration-harness] game 1 (locate): elo=1100 blend=0.0 anchor=sf0 "
    "opening=Test Opening 2 botIsWhite=false",
    "[calibration-harness]   ply 1 (anchor) d2d4 took 1.00s",
    "[calibration-harness]   ply 2 (bot) g8f6 took 0.30s",
    "[calibration-harness] result=draw reason=ply_cap_draw plies=2",
]

_SELF_TEST_LEDGER_HEADER = ("bot_elo", "bot_blend", "anchor", "plies", "game_index")


def _write_self_test_fixture(
    tmp_dir: Path,
    ledger_rows: list[tuple[int, float, str, int, int]],
    log_lines: list[str] = _SELF_TEST_LOG_LINES,
) -> tuple[Path, Path]:
    log_path = tmp_dir / "run.log"
    log_path.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    ledger_path = tmp_dir / "ledger.tsv"
    with ledger_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t")
        writer.writerow(_SELF_TEST_LEDGER_HEADER)
        for row in ledger_rows:
            writer.writerow(row)
    return log_path, ledger_path


def run_self_test() -> None:
    good_rows: list[tuple[int, float, str, int, int]] = [
        (1100, 0.0, "sf0", 3, 0),
        (1100, 0.0, "sf0", 2, 1),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        log_path, ledger_path = _write_self_test_fixture(Path(tmp), good_rows)
        result = parse_run_log(log_path, ledger_path)

        # Case 1+2: ply/mover/seconds extraction, total elapsed, and the
        # bot-only mean (anchor plies contribute to the total but not the mean).
        cell = result["cells"][(1100, 0.0)]
        assert cell["game_count"] == 2, cell
        assert cell["ply_count"] == 5, cell
        expected_total_ms = (0.20 + 1.00 + 0.25 + 1.00 + 0.30) * 1000.0
        assert abs(cell["total_elapsed_ms"] - expected_total_ms) < 1e-6, cell
        expected_bot_mean_ms = ((0.20 + 0.25 + 0.30) / 3) * 1000.0
        assert abs(cell["mean_bot_move_ms"] - expected_bot_mean_ms) < 1e-6, cell

        # Case 3: malformed/unrelated lines are skipped and counted, never raised on.
        assert result["skipped_line_count"] == 6, result
        assert result["total_lines_matched"] == 5, result

    # Case 4: the retired maia900 anchor token (ledger side) must raise.
    retired_rows: list[tuple[int, float, str, int, int]] = [
        (1100, 0.0, "maia900", 3, 0),
        (1100, 0.0, "sf0", 2, 1),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        log_path, ledger_path = _write_self_test_fixture(Path(tmp), retired_rows)
        try:
            parse_run_log(log_path, ledger_path)
        except ValueError as exc:
            assert "maia900" in str(exc), exc
        else:
            raise AssertionError("retired maia900 anchor token should have raised ValueError")

    # Case 5: a ply-count mismatch between the log segment and its ledger row
    # must raise (naming both numbers) rather than silently mis-attributing.
    # The segment (3 plies) is LONGER than the ledger's declared count (2) —
    # not a truncation, so not safely discardable as a crash orphan either.
    mismatched_rows: list[tuple[int, float, str, int, int]] = [
        (1100, 0.0, "sf0", 2, 0),  # the log segment for game 0 is actually 3 plies
        (1100, 0.0, "sf0", 2, 1),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        log_path, ledger_path = _write_self_test_fixture(Path(tmp), mismatched_rows)
        try:
            parse_run_log(log_path, ledger_path)
        except ValueError as exc:
            assert "2" in str(exc) and "3" in str(exc), exc
        else:
            raise AssertionError("a ply-count mismatch should have raised ValueError")

    # Case 6: a crash-orphaned partial segment (shorter than its would-be
    # ledger row, no ledger row of its own) is discarded, never folded into
    # any cell, and the join resyncs onto the real next game correctly —
    # mirrors the real reports/data/sweep-{light,deep}/run.log crash-restart
    # artifact this parser must survive without raising.
    orphan_ledger_rows: list[tuple[int, float, str, int, int]] = [
        (1100, 0.0, "sf0", 3, 0),
        (1100, 0.0, "sf0", 2, 1),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        log_path, ledger_path = _write_self_test_fixture(
            Path(tmp), orphan_ledger_rows, log_lines=_SELF_TEST_LOG_LINES_WITH_ORPHAN
        )
        result = parse_run_log(log_path, ledger_path)
        assert result["orphan_segment_count"] == 1, result
        assert result["orphan_ply_count"] == 1, result
        cell = result["cells"][(1100, 0.0)]
        assert cell["game_count"] == 2, cell  # the orphan is NOT counted as a game
        assert cell["ply_count"] == 5, cell  # 3 + 2, the orphan's 1 ply excluded

    print("OK: parse_calibration_timing_baseline self-test passed.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test", action="store_true", help="Run the fixture self-test and exit"
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help=(
            "A sweep out-dir (e.g. reports/data/sweep-human) containing run.log and its "
            "sibling raw ledger TSV"
        ),
    )
    args = parser.parse_args(argv)

    if args.self_test:
        run_self_test()
        return

    if args.out_dir is None:
        parser.error("--out-dir is required unless --self-test is passed")
        return

    result = parse_run_log_dir(Path(args.out_dir))
    printable = {
        "cells": {
            f"{elo},{blend}": agg
            for (elo, blend), agg in result["cells"].items()  # type: ignore[union-attr]
        },
        "skipped_line_count": result["skipped_line_count"],
        "total_lines_matched": result["total_lines_matched"],
        "orphan_segment_count": result["orphan_segment_count"],
        "orphan_ply_count": result["orphan_ply_count"],
    }
    print(json.dumps(printable, indent=2))


if __name__ == "__main__":
    main()
