"""SEED-153 step 2 gate: re-derive every invariant the scan manifest claims.

The scan (`seed153_scan.mjs`) asserts five things about every row it emits.
Four of them are silent failure modes — a wrong sign convention or a dropped
filter produces a manifest that looks entirely plausible and quietly answers a
different question than the seed asked. This script recomputes each one from
the row's own raw fields and fails loud on any violation:

  D-02  selection rule — the two arms sit on OPPOSITE sides of 0.5 and are at
        least MIN_DELTA_ES apart. A manifest that merely selected on raw
        |ΔES| would be D-03's shrinkage artifact, not a disagreement.
  E-09  `sf_score_white` is the app's own lichess sigmoid of `eval_cp`,
        recomputed here through `eval_cp_to_expected_score` itself rather
        than a copied coefficient — so a drifted constant on either side of
        the language boundary is caught.
  Trap1 `maia_score_white` is the side-to-move -> white POV flip of
        `maia_score_stm`. Getting this backwards inverts the Maia arm and
        would flip the study's conclusion without any other symptom.
  D-04  no surviving row carries a mate score.
  D-05  exactly one row per game_id, so per-game independence holds and no SE
        is silently inflated.

Also reports the phase split and the qualifier-per-game distribution, which
are what the scan budget was sized against.

Usage:
    uv run python scripts/engine_disagreement_study/seed153_verify_manifest.py
    uv run python scripts/engine_disagreement_study/seed153_verify_manifest.py --glob '...'
"""

from __future__ import annotations

import argparse
import glob as globlib
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from app.services.eval_utils import eval_cp_to_expected_score  # noqa: E402

DEFAULT_GLOB = "scripts/engine_disagreement_study/data/seed153_manifest-shard-*-worker-*.ndjson"
# D-02, mirrored from seed153_scan.mjs. Duplicated deliberately: an independent
# restatement is the whole point of a gate — importing the scan's own constant
# would make a drifted threshold invisible.
MIN_DELTA_ES = 0.20
NEUTRAL_ES = 0.5
# Float tolerance for values that crossed the Python -> JSON -> JS -> JSON boundary.
TOL = 1e-9
# The Maia arm is a float32 softmax, so its POV flip is checked a touch looser.
POV_TOL = 1e-12


def _log(msg: str) -> None:
    print(f"[seed153-verify] {msg}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--glob", default=DEFAULT_GLOB)
    args = parser.parse_args()

    # globlib, not Path().glob: the latter raises NotImplementedError on an
    # absolute pattern, which is the natural thing to type when pointing this
    # at a manifest outside the repo.
    paths = [Path(p) for p in sorted(globlib.glob(args.glob))]
    if not paths:
        _log(f"FAIL: no manifest files matched {args.glob!r}")
        sys.exit(1)

    rows = []
    for p in paths:
        with p.open(encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    rows.append(json.loads(line))

    violations: Counter[str] = Counter()
    seen_games: set[int] = set()
    dup_games = 0
    phases: Counter[str] = Counter()
    qualifiers_per_game: Counter[int] = Counter()
    tc_elo: Counter[tuple[str, int]] = Counter()

    for r in rows:
        sf = r["sf_score_white"]
        maia = r["maia_score_white"]

        # D-02: opposite sides of 0.5, and far enough apart.
        if (sf - NEUTRAL_ES) * (maia - NEUTRAL_ES) >= 0:
            violations["D-02 same side of 0.5"] += 1
        if abs(sf - maia) < MIN_DELTA_ES - TOL:
            violations["D-02 delta below threshold"] += 1

        # E-09: the app's own sigmoid, not a copied coefficient.
        if abs(sf - eval_cp_to_expected_score(r["eval_cp"], "white")) > TOL:
            violations["E-09 sigmoid mismatch"] += 1

        # Trap 1: side-to-move -> white POV.
        expected = r["maia_score_stm"] if r["side_to_move"] == "w" else 1 - r["maia_score_stm"]
        if abs(maia - expected) > POV_TOL:
            violations["Trap-1 POV flip"] += 1

        # D-04: mate excluded from the frame.
        if r.get("eval_mate") is not None:
            violations["D-04 mate survived"] += 1

        # D-05: one row per game.
        if r["game_id"] in seen_games:
            dup_games += 1
        seen_games.add(r["game_id"])

        phases[r["phase"]] += 1
        qualifiers_per_game[r["n_qualifiers_in_game"]] += 1
        tc_elo[(r["tc"], r["elo_bucket"])] += 1

    if dup_games:
        violations["D-05 duplicate game_id"] = dup_games

    _log(f"{len(rows)} rows from {len(paths)} shard files")
    _log(f"phase split: middlegame={phases['middlegame']} endgame={phases['endgame']}")
    _log(f"cells covered (tc x elo): {len(tc_elo)}")
    mean_q = (
        sum(k * v for k, v in qualifiers_per_game.items()) / sum(qualifiers_per_game.values())
        if qualifiers_per_game
        else 0.0
    )
    _log(
        f"qualifiers per selected game: mean {mean_q:.2f}, max {max(qualifiers_per_game, default=0)}"
    )

    if violations:
        for name, n in violations.most_common():
            _log(f"FAIL  {name}: {n}")
        sys.exit(1)
    _log("PASS  D-02, D-03 (via opposite-sides), D-04, D-05, E-09, Trap-1 all hold on every row")


if __name__ == "__main__":
    main()
