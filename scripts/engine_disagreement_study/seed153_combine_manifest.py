"""SEED-153 step 2 output: fold the per-worker shard manifests into one .gz.

The scan writes one manifest per (shard, worker) so 12 processes never contend
on a file handle. Steps 3 and 4 want a single input, and the repo's convention
for study manifests is one committed `.gz` (`stage_b_manifest.ndjson.gz`) with
the bulk per-worker files staying local — so this is the step that turns the
scan's output into the study's deliverable.

Adds one field: `boundary`, a straight alias of `phase`. SEED-153's own term
for the middlegame/endgame split is `phase` (the frame is all non-opening
plies, not Stage B's two boundary entries), but `stage_b_sweep.mjs` — which
step 3 reuses for the FlawChess arm — keys its resume ledger on
`(game_id, boundary)`. Aliasing here rather than in the scan keeps the scan's
schema honest while making the manifest a drop-in for that sweep.

Verifies as it goes that D-05 still holds across the union of all shards: a
game must appear exactly once in the combined file, not once per shard. The
shard ranges are disjoint by construction (rank windows over one deterministic
ordering), so a duplicate here means overlapping `--shard`/`--shard-size`
arguments, which would silently inflate n and shrink every SE.

Usage:
    uv run python scripts/engine_disagreement_study/seed153_combine_manifest.py
"""

from __future__ import annotations

import argparse
import glob as globlib
import gzip
import json
import sys
from collections import Counter
from pathlib import Path

DEFAULT_GLOB = "scripts/engine_disagreement_study/data/seed153_manifest-shard-*-worker-*.ndjson"
DEFAULT_OUT = "scripts/engine_disagreement_study/data/seed153_manifest.ndjson.gz"


def _log(msg: str) -> None:
    print(f"[seed153-combine] {msg}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--glob", default=DEFAULT_GLOB)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    paths = sorted(globlib.glob(args.glob))
    if not paths:
        _log(f"FAIL: no manifest files matched {args.glob!r}")
        sys.exit(1)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(".tmp")

    seen: set[int] = set()
    dupes = 0
    phases: Counter[str] = Counter()
    cells: Counter[tuple[str, int]] = Counter()
    written = 0

    with gzip.open(tmp_path, "wt", encoding="utf-8") as out:
        for path in paths:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    if row["game_id"] in seen:
                        dupes += 1
                        continue
                    seen.add(row["game_id"])
                    # Alias for stage_b_sweep.mjs's (game_id, boundary) resume key.
                    row["boundary"] = row["phase"]
                    out.write(json.dumps(row) + "\n")
                    written += 1
                    phases[row["phase"]] += 1
                    cells[(row["tc"], row["elo_bucket"])] += 1

    if dupes:
        tmp_path.unlink(missing_ok=True)
        _log(f"FAIL: {dupes} duplicate game_id across shards — D-05 broken, check --shard ranges")
        sys.exit(1)

    tmp_path.replace(out_path)
    _log(f"{written} rows from {len(paths)} shard files -> {out_path}")
    _log(f"  middlegame={phases['middlegame']}  endgame={phases['endgame']}")
    _log(f"  cells covered (tc x elo): {len(cells)} of 20")
    thin = sorted((n, tc, elo) for (tc, elo), n in cells.items())[:3]
    for n, tc, elo in thin:
        _log(f"  thinnest cell: {tc} x {elo} = {n} rows")


if __name__ == "__main__":
    main()
