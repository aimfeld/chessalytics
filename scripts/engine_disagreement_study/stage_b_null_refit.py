"""SEED-145 Stage B E-14 null-baseline refit at full-study scale.

Re-runs the Gate 0 null-baseline fit (gate0_null_baselines.py logic, reused
verbatim: per-(boundary, tc) weighted IRLS, draws as two half-weight rows,
md5(game_id) fit/eval split, headline + with-flags bases) on the FULL Stage B
manifest — the same frame the engine arms are scored on, with both clocks and
material already recorded per row by stage_b_sample.py.

The resulting eval-half headline Briers replace the Gate 0 estimates
(MG logistic 0.2257, EG 0.1851) as the pre-registered floors `practicalScore`
must beat at both boundaries (E-14 gate).

Pure CPU over the manifest — no DB, no engine. Runs any time after the
sampler; does not need the sweep.

Usage:
    uv run python scripts/engine_disagreement_study/stage_b_null_refit.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gate0_null_baselines import evaluate_boundary  # noqa: E402

DEFAULT_MANIFEST = "scripts/engine_disagreement_study/data/stage_b_manifest.ndjson"
DEFAULT_OUT = "scripts/engine_disagreement_study/data/stage_b_null_baselines.json"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    manifest = [json.loads(line) for line in manifest_path.read_text().splitlines() if line]
    print(f"[null-refit] {len(manifest)} manifest rows from {manifest_path}", flush=True)

    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "config": {
            "source": "Stage B full manifest (stage_b_sample.py, 5000 games/cell)",
            "features": "[1, material_white, elo_diff/100, clock_diff/60, clock_total/60, stm_white]",
            "fit": "per (boundary, tc) weighted IRLS, draws as two half-weight rows",
            "split": "md5(game_id) parity; metrics are eval-half only",
        },
        "middlegame": evaluate_boundary(manifest, "middlegame"),
        "endgame": evaluate_boundary(manifest, "endgame"),
    }
    out_path = Path(args.out)
    out_path.write_text(json.dumps(summary, indent=2) + "\n")

    print("\n=== E-14 null floors at Stage B scale (eval half, headline basis) ===")
    for boundary in ("middlegame", "endgame"):
        s = summary[boundary]
        h = s["headline"]
        print(
            f"{boundary:<12} n={s['n_rows']:<7} "
            f"elo-only: Brier {h['elo_only']['brier']:.4f} / LL {h['elo_only']['log_loss']:.4f} "
            f"(n={h['elo_only']['n_eval']})   "
            f"logistic: Brier {h['material_rating_clock_logistic']['brier']:.4f} / "
            f"LL {h['material_rating_clock_logistic']['log_loss']:.4f} "
            f"(n={h['material_rating_clock_logistic']['n_eval']})"
        )
    print(f"[null-refit] summary -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
