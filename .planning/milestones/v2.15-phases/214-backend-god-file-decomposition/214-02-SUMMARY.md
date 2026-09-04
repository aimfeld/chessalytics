---
phase: 214-backend-god-file-decomposition
plan: 02
subsystem: services
tags: [ruff, complexipy, tactic-detector, refactor, dispatcher-split]

# Dependency graph
requires:
  - phase: 214-01
    provides: "ruff C901/PLR0912/PLR0915 enabled with a baselined per-file-ignores table; scripts/check_function_size.py"
provides:
  - "app/services/tactic_detector.py's dispatcher (detect_tactic_motif) split into three named-stage helpers with zero complexity exemption"
  - "Proof pattern for the phase: mutation-test one extracted helper + byte-identical fixture-harness diff, reusable by 214-03..214-07"
affects: [214-03, 214-04, 214-05, 214-06, 214-07]

# Actuals (#2632)
actuals:
  tokens: 4503
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dispatcher/tiered-candidate pipeline split: try-short-circuit-tier -> None-fallthrough -> collect-candidates -> select-winner, each stage a named function (214-RESEARCH.md Pattern 2)"
    - "Sequential AND-chain branch reduction: extract one named predicate covering a comment-grouped sub-range of conditions, not one helper per condition"
    - "Mutation proof as SUMMARY-recorded evidence: stub an extracted helper's body with an immediate return, confirm the suite goes red, restore, confirm green again"

key-files:
  created: []
  modified:
    - app/services/tactic_detector.py
    - pyproject.toml

key-decisions:
  - "detect_clearance's branch reduction extracted one predicate (_clearance_prior_move_is_valid) covering conditions 3-5 (already comment-grouped in the source as 'require the prior pov move'), not five one-line helpers -- matches the plan's explicit prohibition on over-splitting and the source's own condition grouping."
  - "Kept _dispatch_mate_tier / _collect_non_mate_candidates / _select_shallowest_candidate in the same file (no sibling module) -- the plan directed this; the file has no existing package-split precedent and none was needed here."

requirements-completed: []

coverage:
  - id: D1
    description: "detect_tactic_motif split into a four-step orchestrator (parse PV -> _dispatch_mate_tier -> _collect_non_mate_candidates -> _select_shallowest_candidate) with unchanged tuple return shape/order"
    verification:
      - kind: unit
        ref: "tests/services/test_tactic_detector.py (81 passed, 7 skipped)"
        status: pass
      - kind: other
        ref: "uv run ruff check app/services/tactic_detector.py --config 'lint.per-file-ignores = {}' --output-format concise (no finding on detect_tactic_motif)"
        status: pass
    human_judgment: false
  - id: D2
    description: "detect_clearance brought inside max-branches=12 via one extracted predicate (_clearance_prior_move_is_valid); the 9-condition AND-chain's order and semantics unchanged"
    verification:
      - kind: other
        ref: "uv run ruff check app/services/tactic_detector.py --config 'lint.per-file-ignores = {}' (0 findings, PLR0912 13>12 gone)"
        status: pass
      - kind: unit
        ref: "tests/services/test_tactic_detector.py (81 passed, 7 skipped)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Detection output provably unchanged: tactic-tagger precision/recall harness report byte-identical (modulo Generated timestamp) across all three tasks"
    verification:
      - kind: other
        ref: "PYTHONPATH=. uv run python scripts/tactic_tagger_report.py --check-goals; diff --ignore-matching-lines against 214-02-tactic-report-before.md"
        status: pass
    human_judgment: false
  - id: D4
    description: "app/services/tactic_detector.py's per-file-ignores entry deleted from pyproject.toml; file and project-wide ruff check both green"
    verification:
      - kind: other
        ref: "uv run ruff check app/services/tactic_detector.py && uv run ruff check app/services/tactic_detector.py --config 'lint.per-file-ignores = {}' && uv run ruff check ."
        status: pass
    human_judgment: false
  - id: D5
    description: "Mutation proof: reverting _dispatch_mate_tier to an immediate return None turns 14 tests red; restoring returns the suite to green"
    verification:
      - kind: unit
        ref: "tests/services/test_tactic_detector.py -- 14 failed with stub, 81 passed/7 skipped restored"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-09-02
status: complete
---

# Phase 214 Plan 02: Tactic Detector Dispatcher Split Summary

**`detect_tactic_motif` split into a four-step orchestrator over three named-stage helpers (`_dispatch_mate_tier`, `_collect_non_mate_candidates`, `_select_shallowest_candidate`), `detect_clearance` brought inside the branch limit via one extracted predicate, and the file's ruff complexity exemption deleted — all proven behavior-identical by a byte-for-byte tactic-tagger harness diff and a mutation-test proof.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-09-02T19:56:00Z (approx, oracle capture at 19:58:07Z)
- **Completed:** 2026-09-02T20:10:33Z
- **Tasks:** 3
- **Files modified:** 2 (`app/services/tactic_detector.py`, `pyproject.toml`)

## Accomplishments

- `_dispatch_mate_tier(boards, moves, pov, has_forced_mate) -> tuple[...] | None` now owns Tier 1 (named mates, boden/double-bishop, back-rank, generic mate, and the truncated-mate fallback), returning `None` to signal fall-through instead of the caller checking a pre-computed eligibility flag.
- `_collect_non_mate_candidates(boards, moves, pov) -> list[_Candidate]` owns Tiers 2-5 (geometric, fuzzy, hanging-piece, move-type fallback) in the exact order the inline loops built them.
- `_select_shallowest_candidate(candidates) -> _Candidate | None` names the depth-primary, tier/rank-tiebreak winner-selection rule once instead of leaving it as an inline `min(..., key=lambda...)`.
- `detect_tactic_motif` is now a four-step orchestrator: parse PV → try mate tier → if `None`, collect non-mate candidates → select winner → unpack and return. Its public signature and 4-tuple return shape are unchanged.
- `_clearance_prior_move_is_valid(prev_move, move) -> bool` extracts `detect_clearance`'s conditions 3-5 (already comment-grouped in the source as "require the prior pov move") into one named predicate, bringing the function from `PLR0912` 13>12 branches to inside the limit with zero condition-order or semantics change.
- `pyproject.toml`'s `app/services/tactic_detector.py` per-file-ignores entry (`["C901", "PLR0912"]`) is deleted — the file needs no complexity exemption.
- Complexipy: functions over cognitive complexity 15 in this file went from 16 (214-01 baseline) to 15 — `detect_tactic_motif`'s single complexity-39 entry is replaced by three functions none of which individually exceed 15 (`_dispatch_mate_tier`=13, `_collect_non_mate_candidates`=13); `detect_clearance` dropped from 29 to 25 (still over 15 — cognitive complexity is report-only per 214-01, not a blocking gate).

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract mate tier from detect_tactic_motif, end to end through the harness** — `16e65d1ec` (feat) — tracer task, verified end-to-end (unit tests + byte-identical harness) before expanding.
2. **Task 2: Finish the detect_tactic_motif split — candidate collection and winner selection** — `27f583d42` (feat)
3. **Task 3: detect_clearance branch reduction, mutation proof, and ignore-entry deletion** — `504db95b3` (fix)

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

## Files Created/Modified

- `app/services/tactic_detector.py` — `_dispatch_mate_tier`, `_collect_non_mate_candidates`, `_select_shallowest_candidate`, `_clearance_prior_move_is_valid` added; `detect_tactic_motif` and `detect_clearance` bodies reduced to orchestration over the new helpers. `_INT_TO_MOTIF` and `_parse_pv` untouched, still importable from the same module path.
- `pyproject.toml` — deleted the `app/services/tactic_detector.py` `per-file-ignores` entry.
- `.planning/phases/214-backend-god-file-decomposition/214-02-tactic-report-before.md` — the pre-split byte-identity baseline captured before Task 1 touched the file (committed with Task 1, referenced by all three tasks' verify commands).

## Decisions Made

- **One predicate for `detect_clearance`'s branch reduction, not five.** The plan explicitly forbade extracting five one-line helpers around the 9-condition AND-chain. Conditions 3-5 were already comment-grouped in the source ("require the prior pov move"), so extracting exactly that group as `_clearance_prior_move_is_valid` was the one seam the plan's own guidance pointed at — it dropped the branch count from 13 to well under 12 in one move, with margin to spare.
- **No sibling module for `tactic_detector.py`.** Per the plan and 214-RESEARCH.md's module-split convention, all extracted helpers stayed in the same file — this file has no existing package-split precedent in the codebase and the extractions here are small enough that a sibling file would add import indirection for no benefit.

## Deviations from Plan

None - plan executed exactly as written.

## Mutation Proof (recorded per Task 3)

Temporarily replaced `_dispatch_mate_tier`'s body with an immediate `return None` (stubbing out all mate detection). Result: 14 tests failed —

```
FAILED test_precision_bar_validated[back-rank-mate]
FAILED test_precision_bar_validated[mate]
FAILED test_precision_bar_validated[hook-mate]
FAILED test_suppressed_motifs_documented_and_storable[smothered-mate]
FAILED test_precision_bar_validated[anastasia-mate]
FAILED TestPriorityOrder::test_mate_dominates_over_fork
FAILED TestPriorityOrder::test_all_mate_fixtures_return_mate_family
FAILED TestHasForcedMateFallback::test_truncated_mate_with_flag_tags_mate
FAILED test_positives_fire_expected_motif[anastasia-mate]
FAILED test_positives_fire_expected_motif[hook-mate]
FAILED test_positives_fire_expected_motif[smothered-mate]
FAILED test_positives_fire_expected_motif[dovetail-mate]
FAILED test_positives_fire_expected_motif[mate]
FAILED test_positives_fire_expected_motif[back-rank-mate]
14 failed, 67 passed, 7 skipped in 18.45s
```

Restored the original body: `81 passed, 7 skipped` (green again). This proves the Task 1 extraction is genuinely exercised by the test suite, not merely present and untested.

## Complexipy Before/After (this file)

- **Before (214-01 baseline):** 16 functions over cognitive complexity 15.
- **After:** 15 functions over cognitive complexity 15. `detect_tactic_motif`'s single complexity-39 entry is gone (split into `_dispatch_mate_tier`=13 and `_collect_non_mate_candidates`=13, both under 15; `detect_tactic_motif` itself and `_select_shallowest_candidate` are trivial). `detect_clearance` dropped from complexity 29 to 25 but remains over 15 — expected and acceptable, since complexipy is report-only per 214-01's decision (not CI-gated) and the branch-count gate (`PLR0912`, which IS gated) is now clean.

## 100-200 Logic-LOC Survivors

None. `scripts/check_function_size.py --json` on this file shows a maximum `logic_loc` of 44 (`_deflection_fires_at`), well under the 100-line threshold that would need a one-line justification.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `app/services/tactic_detector.py` carries no complexity exemption in `pyproject.toml`; `ruff check .` stays green project-wide with one fewer baselined file.
- The split-and-prove method (mate-tier tracer task verified end-to-end through the harness before expanding, then finish the split, then mutation-prove + delete the ignore entry) is confirmed working on the file with the strongest oracle in the phase — 214-03..214-07 can reuse this pattern with confidence.
- `.planning/phases/214-backend-god-file-decomposition/214-02-tactic-report-before.md` stays in the repo as the durable byte-identity reference for this file; later plans working on other files should NOT need to touch it.
- Ready for the next wave-2 plan (214-03 or whichever file is executed next); no blockers.

## Self-Check: PASSED

- `app/services/tactic_detector.py` — FOUND on disk
- `.planning/phases/214-backend-god-file-decomposition/214-02-tactic-report-before.md` — FOUND on disk
- Commits `16e65d1ec`, `27f583d42`, `504db95b3` — all FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>`: `uv run pytest -n auto tests/services/test_tactic_detector.py -q` (81 passed, 7 skipped), `uv run ruff check app/services/tactic_detector.py` (clean, with and without the ignore table), `uv run python scripts/check_function_size.py app/services/tactic_detector.py --fail-over-depth 4 --fail-over-loc 200` (OK, exit 0), `uv run ty check app/ tests/ scripts/` (zero errors), `uv run ruff format --check app/ tests/ scripts/` (clean), `uv run pytest -n auto -x -q` (4496 passed, 19 skipped, run during Task 3)

---
*Phase: 214-backend-god-file-decomposition*
*Completed: 2026-09-02*
