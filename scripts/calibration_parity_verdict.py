"""calibration_parity_verdict.py — Phase 199 (D-03/A-04) before/after pooled-shift
parity verdict.

Named `_verdict`, not `_check`, to avoid confusion with the unrelated existing
`scripts/lib/calibration-parity.check.mjs`, which pins bot-move selection
parity (CAL-02) — a different meaning of "parity".

Compares a fresh 5-cell sweep (1 null control + 4 exposed cells, pinned to the
recorded 2026-07-21 anchor brackets, D-02) against the committed per-cell
ratings in `reports/data/bot-curves-internal-scale.json`, and renders the
pre-registered accept-rule (`reports/bot-parity-199/accept-rule.md`) as a
mechanical verdict: void, holds, or fails. The five threshold constants below
are transcribed verbatim from that document and are NOT reachable from any
CLI flag, environment variable, or config file (D-03) — the only legitimate
way to change them is to edit this file and the accept-rule doc together,
before a new sweep starts.

stdlib-only (`argparse`/`json`/`math`/`pathlib`/`sys`) — no numpy/scipy,
matching `calibration_anchor_fit.py`'s convention. Standalone research tool
(`scripts/`, not `app/`) — exempt from CLAUDE.md's Sentry-capture rules, which
apply only to `app/services` and `app/routers`.

Usage (fixture self-test — proves the arithmetic before any real data exists):
    uv run python scripts/calibration_parity_verdict.py --self-test

Usage (real verdict, one --new-cells-tsv per cell out-dir, D-02):
    uv run python scripts/calibration_parity_verdict.py \\
        --old-json reports/data/bot-curves-internal-scale.json \\
        --new-cells-tsv reports/data/sweep-199-human/sweep-199-human-cells.tsv \\
        --new-cells-tsv reports/data/sweep-199-light/sweep-199-light-cells.tsv \\
        --new-cells-tsv reports/data/sweep-199-deep/sweep-199-deep-cells.tsv \\
        --out-json reports/data/bot-parity-199-verdict.json
"""

from __future__ import annotations

import argparse
import json
import math
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Literal, TypedDict

import calibration_anchor_fit as anchor_fit

_REPO_ROOT = Path(__file__).resolve().parent.parent

# ==============================================================================
# Pre-registered parity thresholds (D-03, refined A-04). Fixed BEFORE any
# Phase 199 sweep game was played; see reports/bot-parity-199/accept-rule.md
# for the derivation. NOT editable after the run starts, and not reachable
# from any CLI flag, environment variable, or config file (D-03).
# ==============================================================================
NORMAL_95_Z = 1.959963985
PARITY_POOLED_THRESHOLD_MAIA_ELO = 85.0
PARITY_POOLED_THRESHOLD_SF_ELO = 50.0
NULL_CONTROL_MAX_SHIFT_MAIA_ELO = 165.0
NULL_CONTROL_MAX_SHIFT_SF_ELO = 149.0

Family = Literal["maia", "sf"]
CellKey = tuple[int, float]
Verdict = Literal["void", "holds", "fails"]

DEFAULT_OLD_JSON = str(_REPO_ROOT / "reports" / "data" / "bot-curves-internal-scale.json")
DEFAULT_OUT_JSON = str(_REPO_ROOT / "reports" / "data" / "bot-parity-199-verdict.json")
DEFAULT_INTERNAL_SCALE_JSON = anchor_fit.DEFAULT_INTERNAL_SCALE_JSON


class CellStats(TypedDict):
    """One (bot_elo, bot_blend) cell's fitted rating + committed/bootstrap CI,
    per anchor family. The script keys on (bot_elo, bot_blend) exactly."""

    bot_elo: int
    bot_blend: float
    rating_vs_maia: float
    ci_vs_maia: tuple[float, float]
    rating_vs_sf: float
    ci_vs_sf: tuple[float, float]


class NullControlResult(TypedDict):
    shift: float
    se_shift: float
    threshold: float
    within_threshold: bool


class PooledResult(TypedDict):
    shift: float
    se: float
    threshold: float
    within_threshold: bool
    n_cells: int


class ExposedCellResult(TypedDict):
    bot_elo: int
    bot_blend: float
    shift: float
    se_shift: float
    outside_ci: bool


class FamilyResult(TypedDict):
    null_control: NullControlResult
    pooled: PooledResult
    exposed_cells: list[ExposedCellResult]


class ParityVerdictResult(TypedDict):
    maia: FamilyResult
    sf: FamilyResult
    shape_guard_triggered: list[tuple[int, float]]
    verdict: Verdict


def _se_from_ci(ci_lo: float, ci_hi: float) -> float:
    """SE-from-CI-width, mirrored verbatim from `calibration_anchor_fit.py:83-85`
    so both sides of the comparison use one definition of a standard error.
    Fail-loud on a non-positive width (a malformed/truncated CI is never
    silently treated as a point estimate)."""
    width = ci_hi - ci_lo
    if width <= 0:
        raise ValueError(f"_se_from_ci: non-positive CI width (lo={ci_lo!r}, hi={ci_hi!r})")
    return width / (2.0 * NORMAL_95_Z)


def _rating_and_ci(cell: CellStats, family: Family) -> tuple[float, tuple[float, float]]:
    if family == "maia":
        return cell["rating_vs_maia"], cell["ci_vs_maia"]
    return cell["rating_vs_sf"], cell["ci_vs_sf"]


def _cell_shift(old_cell: CellStats, new_cell: CellStats, family: Family) -> tuple[float, float]:
    """Returns (shift, se_shift) for one cell in one family.
    shift = rating_new - rating_old; se_shift = hypot(se_new, se_old)."""
    rating_old, ci_old = _rating_and_ci(old_cell, family)
    rating_new, ci_new = _rating_and_ci(new_cell, family)
    se_old = _se_from_ci(*ci_old)
    se_new = _se_from_ci(*ci_new)
    return rating_new - rating_old, math.hypot(se_new, se_old)


def _pool_shifts(shifts_and_se: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Inverse-variance-weighted pooled shift + pooled SE, mirroring
    `combine_preset_g_preset` (calibration_anchor_fit.py:669-700): each pair's
    weight is 1/se^2, falling back to an unweighted mean if every SE is
    degenerate (<= 0)."""
    weighted_sum = 0.0
    weight_total = 0.0
    for shift, se in shifts_and_se:
        if se <= 0:
            continue
        weight = 1.0 / (se * se)
        weighted_sum += weight * shift
        weight_total += weight
    if weight_total > 0:
        return weighted_sum / weight_total, math.sqrt(1.0 / weight_total)
    return sum(shift for shift, _se in shifts_and_se) / len(shifts_and_se), float("nan")


def _evaluate_family(
    family: Family,
    null_threshold: float,
    pooled_threshold: float,
    old_cells: dict[CellKey, CellStats],
    new_cells: dict[CellKey, CellStats],
    null_key: CellKey,
    exposed_keys: Sequence[CellKey],
) -> FamilyResult:
    """Evaluates ONE family (never merged with the other, per D-03/fit_all_bot_cells'
    never-merge discipline): the null-control gate, the pooled shift over the
    exposed cells, and each exposed cell's own outside-CI flag (shape-guard input)."""
    null_shift, null_se = _cell_shift(old_cells[null_key], new_cells[null_key], family)
    null_control: NullControlResult = {
        "shift": null_shift,
        "se_shift": null_se,
        "threshold": null_threshold,
        "within_threshold": abs(null_shift) <= null_threshold,
    }

    shifts_and_se: list[tuple[float, float]] = []
    exposed_cells: list[ExposedCellResult] = []
    for key in exposed_keys:
        shift, se_shift = _cell_shift(old_cells[key], new_cells[key], family)
        shifts_and_se.append((shift, se_shift))
        rating_new, _ci_new = _rating_and_ci(new_cells[key], family)
        _rating_old, ci_old = _rating_and_ci(old_cells[key], family)
        outside_ci = rating_new < ci_old[0] or rating_new > ci_old[1]
        exposed_cells.append(
            {
                "bot_elo": key[0],
                "bot_blend": key[1],
                "shift": shift,
                "se_shift": se_shift,
                "outside_ci": outside_ci,
            }
        )

    pooled_shift, pooled_se = _pool_shifts(shifts_and_se)
    pooled: PooledResult = {
        "shift": pooled_shift,
        "se": pooled_se,
        "threshold": pooled_threshold,
        "within_threshold": abs(pooled_shift) <= pooled_threshold,
        "n_cells": len(exposed_keys),
    }
    return {"null_control": null_control, "pooled": pooled, "exposed_cells": exposed_cells}


def _validate_cells(
    old_cells: dict[CellKey, CellStats], new_cells: dict[CellKey, CellStats]
) -> None:
    """Fail-loud on a malformed/truncated comparison set: an empty new_cells, or
    any new_cells key absent from the committed old_cells (a cell present in
    the new data but absent from the old JSON is never silently ignored)."""
    if not new_cells:
        raise ValueError("parity_verdict: new_cells is empty")
    missing = sorted(key for key in new_cells if key not in old_cells)
    if missing:
        raise ValueError(
            f"parity_verdict: cell(s) {missing!r} present in new data but absent from old_cells"
        )


def parity_verdict(
    old_cells: dict[CellKey, CellStats], new_cells: dict[CellKey, CellStats]
) -> ParityVerdictResult:
    """Renders the accept-rule (reports/bot-parity-199/accept-rule.md) as a
    mechanical verdict: void wins over everything, fails wins over holds.

    Evaluation order per family: validity gate (null control) first, then the
    primary pooled-shift criterion over the 4 exposed cells, then the shape
    guard (computed across BOTH families' per-cell outside_ci flags). The Maia
    and SF families are evaluated in completely separate code paths and never
    merged into one number before any threshold check.
    """
    _validate_cells(old_cells, new_cells)

    null_keys = sorted(key for key in new_cells if key[1] == 0.0)
    if len(null_keys) != 1:
        raise ValueError(
            f"parity_verdict: expected exactly one blend-0 null-control cell in "
            f"new_cells, got {len(null_keys)}: {null_keys!r}"
        )
    null_key = null_keys[0]
    exposed_keys = sorted(key for key in new_cells if key != null_key)
    if not exposed_keys:
        raise ValueError("parity_verdict: no exposed cells (bot_blend != 0.0) in new_cells")

    maia = _evaluate_family(
        "maia",
        NULL_CONTROL_MAX_SHIFT_MAIA_ELO,
        PARITY_POOLED_THRESHOLD_MAIA_ELO,
        old_cells,
        new_cells,
        null_key,
        exposed_keys,
    )
    sf = _evaluate_family(
        "sf",
        NULL_CONTROL_MAX_SHIFT_SF_ELO,
        PARITY_POOLED_THRESHOLD_SF_ELO,
        old_cells,
        new_cells,
        null_key,
        exposed_keys,
    )

    is_void = (
        not maia["null_control"]["within_threshold"] or not sf["null_control"]["within_threshold"]
    )
    shape_guard_triggered = [
        (m["bot_elo"], m["bot_blend"])
        for m, s in zip(maia["exposed_cells"], sf["exposed_cells"], strict=True)
        if m["outside_ci"] and s["outside_ci"]
    ]
    is_fails = (
        not maia["pooled"]["within_threshold"]
        or not sf["pooled"]["within_threshold"]
        or bool(shape_guard_triggered)
    )

    if is_void:
        verdict: Verdict = "void"
    elif is_fails:
        verdict = "fails"
    else:
        verdict = "holds"

    return {
        "maia": maia,
        "sf": sf,
        "shape_guard_triggered": shape_guard_triggered,
        "verdict": verdict,
    }


# ==============================================================================
# Real-data loading (Task 2 wiring): committed old JSON + one-or-more new
# `-cells.tsv` aggregates, fit via the EXISTING calibration_anchor_fit
# functions unmodified — this script never writes a second fitter.
# ==============================================================================


def load_old_cells(path: str) -> dict[CellKey, CellStats]:
    """Reads the committed comparison target
    (reports/data/bot-curves-internal-scale.json's `cells[]`), keyed on
    (bot_elo, bot_blend) exactly."""
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    cells = payload.get("cells")
    if not isinstance(cells, list) or not cells:
        raise ValueError(f"load_old_cells: {path!r} has no non-empty 'cells' list")

    result: dict[CellKey, CellStats] = {}
    for cell in cells:
        key = (int(cell["bot_elo"]), float(cell["bot_blend"]))
        result[key] = {
            "bot_elo": key[0],
            "bot_blend": key[1],
            "rating_vs_maia": float(cell["rating_vs_maia"]),
            "ci_vs_maia": (float(cell["ci_vs_maia"][0]), float(cell["ci_vs_maia"][1])),
            "rating_vs_sf": float(cell["rating_vs_sf"]),
            "ci_vs_sf": (float(cell["ci_vs_sf"][0]), float(cell["ci_vs_sf"][1])),
        }
    return result


def fit_new_cells(
    tsv_paths: Iterable[str],
    fixed_ratings: dict[str, float],
    n_bootstrap: int,
    seed: int,
) -> dict[CellKey, CellStats]:
    """Loads one-or-more per-(cell, anchor) aggregate TSVs (D-02: each cell is a
    separate sweep invocation with its own aggregate) via the EXISTING
    `load_bot_cells` / `fit_bot_cell_rating` / `bootstrap_bot_cell_ci` — never a
    second fitter — keyed on (bot_elo, bot_blend)."""
    result: dict[CellKey, CellStats] = {}
    for path in tsv_paths:
        for cell in anchor_fit.load_bot_cells(path):
            key = (cell["bot_elo"], cell["bot_blend"])
            wins_maia, games_maia = anchor_fit._fold_wdl(cell["wdl_vs_maia"])  # noqa: SLF001
            wins_sf, games_sf = anchor_fit._fold_wdl(cell["wdl_vs_sf"])  # noqa: SLF001
            rating_vs_maia = anchor_fit.fit_bot_cell_rating(wins_maia, games_maia, fixed_ratings)
            rating_vs_sf = anchor_fit.fit_bot_cell_rating(wins_sf, games_sf, fixed_ratings)
            ci_vs_maia = anchor_fit.bootstrap_bot_cell_ci(
                cell["wdl_vs_maia"], fixed_ratings, n_bootstrap, seed
            )
            ci_vs_sf = anchor_fit.bootstrap_bot_cell_ci(
                cell["wdl_vs_sf"], fixed_ratings, n_bootstrap, seed + 1
            )
            result[key] = {
                "bot_elo": key[0],
                "bot_blend": key[1],
                "rating_vs_maia": rating_vs_maia,
                "ci_vs_maia": ci_vs_maia,
                "rating_vs_sf": rating_vs_sf,
                "ci_vs_sf": ci_vs_sf,
            }
    return result


def _write_verdict(path: str, verdict: ParityVerdictResult) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(verdict, indent=2, sort_keys=True) + "\n", encoding="utf-8")


# ==============================================================================
# --self-test: hardcoded, obviously-synthetic fixture numbers (NOT the real
# internal scale) proving the six behaviors in the plan's <behavior> block.
# ==============================================================================


def _self_test_cell(
    elo: int, blend: float, rating_maia: float, half_maia: float, rating_sf: float, half_sf: float
) -> CellStats:
    return {
        "bot_elo": elo,
        "bot_blend": blend,
        "rating_vs_maia": rating_maia,
        "ci_vs_maia": (rating_maia - half_maia, rating_maia + half_maia),
        "rating_vs_sf": rating_sf,
        "ci_vs_sf": (rating_sf - half_sf, rating_sf + half_sf),
    }


def _self_test_old_cells() -> dict[CellKey, CellStats]:
    """Synthetic, clearly-fake 5-cell committed baseline (NOT the real internal
    scale) — only used to prove parity_verdict's arithmetic on numbers with a
    known-by-construction true shift."""
    return {
        (1100, 0.0): _self_test_cell(1100, 0.0, 1000.0, 100.0, 1000.0, 100.0),
        (1300, 0.05): _self_test_cell(1300, 0.05, 1500.0, 80.0, 1300.0, 60.0),
        (1900, 0.05): _self_test_cell(1900, 0.05, 1900.0, 80.0, 1700.0, 60.0),
        (1500, 0.5): _self_test_cell(1500, 0.5, 1600.0, 80.0, 1400.0, 60.0),
        (2300, 0.5): _self_test_cell(2300, 0.5, 2300.0, 80.0, 2100.0, 60.0),
    }


def _self_test_shift_cells(
    old_cells: dict[CellKey, CellStats],
    keys_to_shift: Iterable[CellKey],
    shift_maia: float,
    shift_sf: float,
) -> dict[CellKey, CellStats]:
    """Copies old_cells, shifting only `keys_to_shift`'s rating (and its CI,
    same width, shifted along) by the given amounts; every other key is an
    unshifted (shift 0) copy."""
    keys_to_shift = set(keys_to_shift)
    result: dict[CellKey, CellStats] = {}
    for key, cell in old_cells.items():
        s_maia = shift_maia if key in keys_to_shift else 0.0
        s_sf = shift_sf if key in keys_to_shift else 0.0
        lo_m, hi_m = cell["ci_vs_maia"]
        lo_s, hi_s = cell["ci_vs_sf"]
        result[key] = {
            "bot_elo": cell["bot_elo"],
            "bot_blend": cell["bot_blend"],
            "rating_vs_maia": cell["rating_vs_maia"] + s_maia,
            "ci_vs_maia": (lo_m + s_maia, hi_m + s_maia),
            "rating_vs_sf": cell["rating_vs_sf"] + s_sf,
            "ci_vs_sf": (lo_s + s_sf, hi_s + s_sf),
        }
    return result


def _self_test_point_excursion(
    old_cells: dict[CellKey, CellStats], key: CellKey, delta_maia: float, delta_sf: float
) -> dict[CellKey, CellStats]:
    """Copies old_cells unchanged except one cell's POINT ESTIMATE is pushed by
    (delta_maia, delta_sf) while its CI stays exactly where it was committed —
    concretely what "the new estimate lands outside its committed CI" means."""
    result = _self_test_shift_cells(old_cells, [], 0.0, 0.0)
    cell = result[key]
    result[key] = {
        "bot_elo": cell["bot_elo"],
        "bot_blend": cell["bot_blend"],
        "rating_vs_maia": cell["rating_vs_maia"] + delta_maia,
        "ci_vs_maia": cell["ci_vs_maia"],
        "rating_vs_sf": cell["rating_vs_sf"] + delta_sf,
        "ci_vs_sf": cell["ci_vs_sf"],
    }
    return result


def run_self_test() -> None:
    old_cells = _self_test_old_cells()
    exposed_keys = [(1300, 0.05), (1900, 0.05), (1500, 0.5), (2300, 0.5)]

    # 1. True pooled shift 0 by construction -> pooled ~0, HOLDS both families.
    holds_cells = _self_test_shift_cells(old_cells, old_cells.keys(), 0.0, 0.0)
    result = parity_verdict(old_cells, holds_cells)
    assert result["verdict"] == "holds", f"expected holds, got {result['verdict']!r}: {result}"
    assert abs(result["maia"]["pooled"]["shift"]) < 1.0
    assert abs(result["sf"]["pooled"]["shift"]) < 1.0

    # 2. Same fixture shifted by +200 in every EXPOSED cell (null control
    #    untouched, so the validity gate stays clear) -> pooled ~+200, FAILS both.
    fails_cells = _self_test_shift_cells(old_cells, exposed_keys, 200.0, 200.0)
    result = parity_verdict(old_cells, fails_cells)
    assert result["verdict"] == "fails", f"expected fails, got {result['verdict']!r}: {result}"
    assert result["maia"]["pooled"]["shift"] > 150.0
    assert result["sf"]["pooled"]["shift"] > 150.0
    assert not result["maia"]["pooled"]["within_threshold"]
    assert not result["sf"]["pooled"]["within_threshold"]

    # 3. Pooled criterion HOLDS but one exposed cell's new estimate lands
    #    outside its committed CI in BOTH families -> shape guard fires -> FAILS.
    shape_cells = _self_test_point_excursion(old_cells, (1500, 0.5), 90.0, 90.0)
    result = parity_verdict(old_cells, shape_cells)
    assert result["maia"]["pooled"]["within_threshold"], "pooled maia should still hold"
    assert result["sf"]["pooled"]["within_threshold"], "pooled sf should still hold"
    assert (1500, 0.5) in result["shape_guard_triggered"]
    assert result["verdict"] == "fails", f"expected fails, got {result['verdict']!r}: {result}"

    # 4. Same single-cell excursion in only ONE family -> shape guard does NOT fire.
    one_family_cells = _self_test_point_excursion(old_cells, (1500, 0.5), 90.0, 0.0)
    result = parity_verdict(old_cells, one_family_cells)
    assert result["shape_guard_triggered"] == []
    assert result["verdict"] == "holds", f"expected holds, got {result['verdict']!r}: {result}"

    # 5. Null-control shift exceeding NULL_CONTROL_MAX_SHIFT_MAIA_ELO -> VOID,
    #    regardless of the (otherwise pristine) exposed cells.
    void_cells = _self_test_point_excursion(old_cells, (1100, 0.0), 200.0, 0.0)
    result = parity_verdict(old_cells, void_cells)
    assert result["verdict"] == "void", f"expected void, got {result['verdict']!r}: {result}"

    # 6a. A cell present in the new data but absent from old_cells raises loud.
    malformed_missing = dict(holds_cells)
    malformed_missing[(9999, 0.05)] = malformed_missing[(1300, 0.05)]
    try:
        parity_verdict(old_cells, malformed_missing)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for a cell absent from old_cells")

    # 6b. A CI whose width is zero raises loud (via the full parity_verdict
    #     path, not just the _se_from_ci helper in isolation).
    zero_width_cells = _self_test_shift_cells(old_cells, [], 0.0, 0.0)
    zero_cell = zero_width_cells[(1300, 0.05)]
    zero_width_cells[(1300, 0.05)] = {
        "bot_elo": zero_cell["bot_elo"],
        "bot_blend": zero_cell["bot_blend"],
        "rating_vs_maia": zero_cell["rating_vs_maia"],
        "ci_vs_maia": (1500.0, 1500.0),
        "rating_vs_sf": zero_cell["rating_vs_sf"],
        "ci_vs_sf": zero_cell["ci_vs_sf"],
    }
    try:
        parity_verdict(old_cells, zero_width_cells)
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for a zero-width CI")

    print("OK: calibration_parity_verdict self-test passed.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test", action="store_true", help="Run the fixture self-test and exit"
    )
    parser.add_argument(
        "--old-json", default=DEFAULT_OLD_JSON, help="Committed comparison target (cells[])"
    )
    parser.add_argument(
        "--new-cells-tsv",
        action="append",
        default=None,
        help="Per-cell aggregate TSV (repeatable, one per cell out-dir, D-02)",
    )
    parser.add_argument(
        "--internal-scale-json",
        default=DEFAULT_INTERNAL_SCALE_JSON,
        help="Path to the 10 fixed anchor INTERNAL_RATING values",
    )
    parser.add_argument("--out-json", default=DEFAULT_OUT_JSON, help="Verdict output path")
    parser.add_argument(
        "--bootstrap-samples", type=int, default=anchor_fit.DEFAULT_BOOTSTRAP_SAMPLES
    )
    parser.add_argument("--seed", type=int, default=anchor_fit.DEFAULT_BOOTSTRAP_SEED)
    args = parser.parse_args(argv)

    if args.self_test:
        run_self_test()
        return

    if not args.new_cells_tsv:
        raise ValueError("main: --new-cells-tsv is required (repeatable) unless --self-test")

    old_cells = load_old_cells(args.old_json)
    fixed_ratings = anchor_fit.load_fixed_ratings(args.internal_scale_json)
    new_cells = fit_new_cells(args.new_cells_tsv, fixed_ratings, args.bootstrap_samples, args.seed)
    verdict = parity_verdict(old_cells, new_cells)
    _write_verdict(args.out_json, verdict)
    print(f"Wrote {args.out_json} — verdict: {verdict['verdict']}")


if __name__ == "__main__":
    main()
