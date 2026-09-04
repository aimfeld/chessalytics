---
phase: 214-backend-god-file-decomposition
plan: 03
subsystem: services
tags: [ruff, complexipy, endgame-service, refactor, accumulate-then-build-split]

# Dependency graph
requires:
  - phase: 214-01
    provides: "ruff C901/PLR0912/PLR0915 enabled with a baselined per-file-ignores table; scripts/check_function_size.py"
  - phase: 214-02
    provides: "Split-and-prove method (tracer task verified end-to-end, mutation proof, delete ignore entry)"
provides:
  - "app/services/endgame_service.py's two worst aggregation functions (_aggregate_endgame_stats, _aggregate_endgame_stats_by_tc) share one normalize/accumulate/build pipeline with zero complexity exemption"
  - "Accumulate-then-build split pattern applied a third time (_compute_per_tc_metric_cards) and a branch-reduction-via-pure-helper pattern for tuple-mutation loops (_iterate_clock_rows)"
affects: [214-04, 214-05, 214-06, 214-07, 214-08]

# Actuals (#2632)
actuals:
  tokens: 17290
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Accumulate-then-build pipeline with a shared TypedDict accumulator bundle (_EndgameAccumulators, 11 keys) consumed by two structurally different callers via a boolean flag (track_eval_and_played_at) that gates a caller-specific subset of the accumulation, rather than duplicating the per-row loop"
    - "A caller with an incompatible raw-row shape (tuple test-fixture layout embeds an extra column) keeps its own small row-shape dispatch, but constructs the SAME typed intermediate (_EndgameRow) so it can still call into the shared accumulate/build helpers"
    - "Pure (wins, draws, losses) tuple-incrementer with an invert flag, replacing two near-duplicate if/elif/else blocks (one direct, one outcome-inverted) with one 3-branch helper called twice"

key-files:
  modified:
    - app/services/endgame_service.py
    - pyproject.toml

key-decisions:
  - "_accumulate_endgame_rows takes already-normalized _EndgameRow sequences, not raw rows -- _aggregate_endgame_stats normalizes via _normalize_endgame_row first (list comprehension), then calls accumulate. _aggregate_endgame_stats_by_tc builds _EndgameRow objects directly from its OWN row-shape dispatch (its tuple test-fixture layout embeds time_control_bucket at index 6, shifting next_entry_eval_cp/mate to 7/8 -- a genuinely different tuple shape than the pooled path's, so _normalize_endgame_row cannot be reused on by_tc's tuple fixtures without silently misreading fields)."
  - "track_eval_and_played_at=False on the by_tc caller is the mechanism that keeps output byte-identical: without it, the shared _build_category_stats would populate avg_eval_pawns/eval_n/eval_confidence/last_played_at on categories_by_tc -- a field EndgameStatsResponse actually serializes to the API -- where the pre-split by_tc code always left them at schema defaults (explicit last_played_at=None, no eval kwargs at all). Verified: EndgameCategoryStats.last_played_at/avg_eval_pawns/eval_baseline_pawns default to None/None/0.25, and EVAL_BASELINE_PAWNS_WHITE==0.25, so a caller that never accumulates eval/played_at data produces the exact same wire output as one that explicitly omitted those constructor kwargs."
  - "_accumulate_endgame_rows itself initially breached PLR0912 (16>12) after task 2's plain extraction -- had to further split it into _accumulate_wdl_conv_recov / _accumulate_score_gap / _accumulate_eval_and_played_at (one function per accumulator family) to land under the branch threshold, matching CLAUDE.md's 'pipeline orchestrators -> one function per stage' seam one level deeper than the plan's task 2 action text anticipated."
  - "_iterate_clock_rows's branch reduction extracted two small pure helpers (_bump_timeout_counts, _bump_wdl_tuple) rather than a single named eligibility predicate -- the row-eligibility skip conditions were already early continues pre-split (nothing to invert), so the actual PLR0912 pressure came from the two near-duplicate WDL-tuple if/elif/else update blocks (user-side, opponent-side-inverted) and the timeout if/elif, not from the skip guards the task's read_first anticipated."

requirements-completed: []

coverage:
  - id: D1
    description: "_aggregate_endgame_stats becomes a thin normalize->accumulate->build->sort->return orchestrator sharing _accumulate_endgame_rows/_build_category_stats with _aggregate_endgame_stats_by_tc; neither breaches C901/PLR0912/PLR0915, 200 logic LOC, or nesting depth 4"
    requirement: null
    verification:
      - kind: unit
        ref: "tests/test_endgame_service.py + tests/services/test_endgame_service.py + tests/test_aggregation_sanity.py + tests/services/test_endgame_service_chip_decoupling.py (372 passed)"
        status: pass
      - kind: other
        ref: "uv run ruff check app/services/endgame_service.py --config 'lint.per-file-ignores = {}' --output-format concise (no finding on either function)"
        status: pass
      - kind: other
        ref: "uv run python scripts/check_function_size.py app/services/endgame_service.py --fail-over-depth 4 --fail-over-loc 200 (OK: 51 functions scanned, no breaches)"
        status: pass
    human_judgment: false
  - id: D2
    description: "_compute_per_tc_metric_cards and _iterate_clock_rows brought inside ruff's complexity thresholds via extracted single-purpose helpers, with zero output-order or same-quintile-counting change"
    requirement: null
    verification:
      - kind: other
        ref: "uv run ruff check app/services/endgame_service.py --config 'lint.per-file-ignores = {}' (0 findings after task 3, was 5 including these two functions after task 2)"
        status: pass
      - kind: unit
        ref: "372-test four-module oracle, unchanged passed count"
        status: pass
    human_judgment: false
  - id: D3
    description: "app/services/endgame_service.py's per-file-ignores entry deleted from pyproject.toml; file and project-wide ruff check both green; full backend suite green"
    verification:
      - kind: other
        ref: "uv run ruff check app/services/endgame_service.py && uv run ruff check app/services/endgame_service.py --config 'lint.per-file-ignores = {}' && uv run ruff check ."
        status: pass
      - kind: other
        ref: "uv run pytest -n auto -x -q (4496 passed, 19 skipped)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Mutation proof: stubbing _build_category_stats to return a zero-filled record turns a real subset of the oracle red; restoring returns it to green"
    verification:
      - kind: unit
        ref: "tests/test_endgame_service.py + tests/test_aggregation_sanity.py -- 41 failed with stub, 372 passed restored"
        status: pass
    human_judgment: false

duration: 38min
completed: 2026-09-02
status: complete
---

# Phase 214 Plan 03: Endgame Service Aggregation Split Summary

**`_aggregate_endgame_stats` and `_aggregate_endgame_stats_by_tc` (the phase's single worst offender at complexipy 69/70 and a 251-logic-LOC hard breach) now share one normalize/accumulate/build pipeline via an 11-field `_EndgameAccumulators` TypedDict, with the per-TC breakdown's byte-identical output preserved through a `track_eval_and_played_at` flag; `_compute_per_tc_metric_cards` and `_iterate_clock_rows` are split the same way, and the file's ruff complexity exemption is gone.**

## Performance

- **Duration:** ~38 min
- **Started:** 2026-09-02T20:03:00Z (approx)
- **Completed:** 2026-09-02T20:39:07Z
- **Tasks:** 3
- **Files modified:** 2 (`app/services/endgame_service.py`, `pyproject.toml`)

## Accomplishments

- `_EndgameRow` (NamedTuple, 8 fields) and `_normalize_endgame_row()` collapse the 6/8/9-tuple-vs-SA-`Row` dispatch that was `_aggregate_endgame_stats`'s deepest nesting into one typed row, with `game_id` intentionally omitted (read but never consumed downstream).
- `_EndgameAccumulators` (TypedDict, 11 keys, following `app/services/stats_service.py::FilterParams`'s docstring convention) plus `_accumulate_endgame_rows()` (further split into `_accumulate_wdl_conv_recov`, `_accumulate_score_gap`, `_accumulate_eval_and_played_at` to stay under `PLR0912`) and `_build_category_stats()` — the shared normalize→accumulate→build pipeline both aggregate functions now call.
- `_aggregate_endgame_stats_by_tc` keeps its own row-shape dispatch (its tuple test fixtures embed `time_control_bucket` at index 6 where the pooled path's fixtures don't — a genuinely incompatible tuple layout, not a name collision to paper over), but constructs the same `_EndgameRow` and calls `_accumulate_endgame_rows(tc_rows, track_eval_and_played_at=False)` once per TC bucket instead of carrying its own 100+ line copy of the accumulate/build logic.
- `_compute_per_tc_metric_cards` split into `_accumulate_per_tc_stats` (single pass, using new `_bump_bucket_wdl`/`_append_bucket_gap` helpers to stay under `PLR0912`) and `_build_tc_metric_card` (per-TC card, reusing the pre-existing `_build_per_tc_bucket_stats`).
- `_iterate_clock_rows` split via `_bump_timeout_counts` and `_bump_wdl_tuple` (a pure `(wins, draws, losses)` incrementer with an `invert` flag for the opponent-side quintile split) — the D-04 same-quintile covariance-correction counting logic (`tc_shared_quintile_count`) is untouched.
- `pyproject.toml`'s `app/services/endgame_service.py` per-file-ignores entry (`["C901", "PLR0912", "PLR0915"]`) deleted — the file needs no complexity exemption; `ruff check .` stays green project-wide.
- Sentry capture site count stays exactly 1 (moved into `_accumulate_endgame_rows` with its `endgame_class is None` guard branch, per the threat register's T-214-03-02 mitigation).

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract the row-shape normalizer from `_aggregate_endgame_stats`** — `9203c376a` (feat) — tracer task, verified end-to-end (372-test oracle + Sentry-count grep + ruff format/ty) before expanding; auto-mode/interactive gate row 3 applied (interactive, `end-of-phase`, `<verify>` carried only `<automated>`), so expansion proceeded without a checkpoint.
2. **Task 2: Accumulate/build split shared by both aggregate functions** — `176d5ce5a` (feat)
3. **Task 3: Per-TC cards, clock-row branches, mutation proof, and ignore-entry deletion** — `5046cbf88` (fix)

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

## Files Created/Modified

- `app/services/endgame_service.py` — `_EndgameRow`, `_EndgameAccumulators`, `_normalize_endgame_row`, `_new_endgame_accumulators`, `_capture_invalid_endgame_class`, `_accumulate_wdl_conv_recov`, `_accumulate_score_gap`, `_accumulate_eval_and_played_at`, `_accumulate_endgame_rows`, `_build_category_stats`, `_bump_bucket_wdl`, `_append_bucket_gap`, `_accumulate_per_tc_stats`, `_build_tc_metric_card`, `_bump_timeout_counts`, `_bump_wdl_tuple` added; `_aggregate_endgame_stats`, `_aggregate_endgame_stats_by_tc`, `_compute_per_tc_metric_cards`, `_iterate_clock_rows` bodies reduced to orchestration over the new helpers. `_aggregate_per_tc_percentile` and `count_endgame_games` untouched, still importable/patchable from the same module path.
- `pyproject.toml` — deleted the `app/services/endgame_service.py` per-file-ignores entry.

## Decisions Made

See `key-decisions` in frontmatter — the four decisions there (accumulate takes `_EndgameRow` not raw rows; `track_eval_and_played_at` as the byte-identity mechanism; `_accumulate_endgame_rows` needed a further one-function-per-accumulator-family split to clear `PLR0912`; `_iterate_clock_rows`'s real complexity pressure was the WDL-tuple update blocks, not the skip guards) are the substantive engineering calls this plan made beyond the plan's literal text.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `_accumulate_endgame_rows` itself breached PLR0912 after the plain task-2 extraction**
- **Found during:** Task 2, post-implementation ruff check
- **Issue:** Moving `_aggregate_endgame_stats`'s per-row loop body verbatim into `_accumulate_endgame_rows` (task 2's literal action text) produced a function with 16 branches (`C901` 16>15, `PLR0912` 16>12) — the plan's task 2 action described the SPLIT but didn't anticipate that the consolidated per-row loop would itself re-breach the same threshold it was extracted to fix.
- **Fix:** Further split `_accumulate_endgame_rows`'s per-row body into `_accumulate_wdl_conv_recov` (WDL + conversion/recovery), `_accumulate_score_gap` (the ΔES span-gap accumulation), and `_accumulate_eval_and_played_at` (the eval-mean cohort + MAX(played_at) tracking) — one function per accumulator family, matching CLAUDE.md's "pipeline orchestrators -> one function per stage" seam applied one level deeper than task 2's action text.
- **Files modified:** `app/services/endgame_service.py`
- **Verification:** `uv run ruff check app/services/endgame_service.py --config 'lint.per-file-ignores = {}'` clean; 372-test oracle unchanged.
- **Committed in:** `176d5ce5a` (Task 2 commit)

**2. [Rule 1 - Bug] `_aggregate_endgame_stats_by_tc` cannot reuse `_normalize_endgame_row` on its own tuple test fixtures**
- **Found during:** Task 2, design phase (before implementation) — cross-checked the by_tc test fixture docstring against the pooled path's tuple shapes.
- **Issue:** The plan's key_links state both aggregate functions use "the shared `_normalize_endgame_row` / `_accumulate_endgame_rows` / `_build_category_stats` helpers", implying `_normalize_endgame_row` is reusable everywhere. But `_aggregate_endgame_stats_by_tc`'s tuple test fixtures embed `time_control_bucket` at index 6 (shifting `next_entry_eval_cp`/`next_entry_eval_mate` to indices 7/8), while the pooled path's fixtures have no `tc` column at all — a 9-element tuple means something different in each function's tests. Calling `_normalize_endgame_row` on by_tc's raw tuple rows would silently misread the `tc` string as `next_entry_eval_cp`, producing plausible-but-wrong aggregates (exactly the threat register's T-214-03-01 risk).
- **Fix:** `_aggregate_endgame_stats_by_tc` keeps its own row-shape dispatch (unchanged in substance from the pre-split code) but constructs `_EndgameRow` objects directly from the unpacked fields, then calls the shared `_accumulate_endgame_rows`/`_build_category_stats` pipeline once per TC bucket — satisfying the plan's acceptance criterion ("calls `_accumulate_endgame_rows` and `_build_category_stats`") without corrupting data through an incompatible shared parser.
- **Files modified:** `app/services/endgame_service.py`
- **Verification:** All `TestAggregateEndgameStatsByTc` tests (9 tests using the TC-tuple fixture shape) pass unchanged.
- **Committed in:** `176d5ce5a` (Task 2 commit)

**3. [Rule 1 - Bug] Shared `_build_category_stats` would have leaked eval/last_played_at into the by_tc API response without a gating flag**
- **Found during:** Task 2, design phase — traced `categories_by_tc`'s actual consumer (`EndgameStatsResponse.categories_by_tc`, a directly-serialized API field) before committing to the shared-builder design.
- **Issue:** The pre-split `_aggregate_endgame_stats_by_tc` never accumulated eval-mean or `last_played_at` data (its `EndgameCategoryStats` constructor omitted those kwargs / passed `last_played_at=None` explicitly). If the shared `_build_category_stats` unconditionally read populated `eval_n_by_class`/`last_played_at_by_class` accumulators, `categories_by_tc` — a field the frontend consumes directly via `EndgameStatsResponse` — would start returning real `avg_eval_pawns`/`last_played_at` values where it previously always returned `None`, a genuine, silent API behavior change the byte-identity oracle's existing tests don't happen to assert against.
- **Fix:** Added `track_eval_and_played_at: bool = True` to `_accumulate_endgame_rows`; the by_tc caller passes `False`, so those two accumulator families stay at their defaultdict defaults for every class and `_build_category_stats` naturally reproduces the exact same schema-default output the pre-split code produced explicitly.
- **Files modified:** `app/services/endgame_service.py`
- **Verification:** Confirmed `EndgameCategoryStats.avg_eval_pawns`/`last_played_at` default to `None` and `eval_baseline_pawns` defaults to `0.25` (matching `EVAL_BASELINE_PAWNS_WHITE`), so passing `last_played_at=None`/leaving eval accumulators empty is byte-identical to the old omitted-kwargs call. All 372 tests pass, including the by_tc-specific tests that don't happen to assert on these fields (this was a silent-regression risk the test suite alone would not have caught — traced by hand against the schema and the response consumer, not by test failure).
- **Committed in:** `176d5ce5a` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 1 — design corrections discovered while implementing the plan's task 2 split, before any code shipped with the bug; none required a revert).
**Impact on plan:** All three deviations are necessary refinements of the plan's own "share the same helpers" instruction, needed to keep the phase's zero-behavior-change contract intact. No scope creep — no new files, no test changes, no architectural change beyond what the plan specified.

## Mutation Proof (recorded per Task 3)

Temporarily replaced `_build_category_stats`'s body with an immediate zero-filled `EndgameCategoryStats` return (endgame_class/label preserved, everything else 0/0.0/None). Result: 41 of 372 tests failed —

```
41 failed, 331 passed in 24.04s
```

Failures spanned `TestAggregateEndgameStats` (9), `TestAggregateEndgameStatsByTc` (7), `TestAggregateEndgameStatsTypeScoreGap` (8), `TestEndgameCategoryStatsWdlAlignedFields` (8), `TestStartEndScoreMeans` (4), `TestPerClassScorePValue` (2), `TestPhase872PerBucketDeltaES` (1), and `TestEndgameClassTransition` (1 in `test_aggregation_sanity.py`) — confirming `_build_category_stats` is genuinely exercised by both the pooled and per-TC test suites, not merely present and untested.

Restored the original body: `372 passed` (green again).

## Complexipy Before/After (this file)

- **Before (214-01 baseline):** 12 functions over cognitive complexity 15.
- **After:** 10 functions over cognitive complexity 15 — `_aggregate_endgame_stats` (was complexity 69) and `_compute_per_tc_metric_cards` (was 16) no longer appear on the list; the remaining 10 (`_iterate_clock_rows`=16, `get_endgame_elo_timeline`=17, `_aggregate_endgame_stats_by_tc`=19, `_build_per_tc_bucket_stats`=19, `get_endgame_overview`=19, `get_endgame_timeline`=20, `_compute_score_gap_timeline`=21, `_aggregate_bucket_counts`=22, `_compute_clock_diff_timeline`=27, `_get_endgame_performance_from_rows`=28) are expected and acceptable — complexipy stays report-only per 214-01's decision (not CI-gated); the branch-count gate (`PLR0912`, which IS gated) is clean for every function in this file.

## 100-200 Logic-LOC Survivors

`scripts/check_function_size.py --json` on this file (`--fail-over-loc 200 --fail-over-depth 4` exits 0; the listing below is every function between 100 and 200 logic LOC, none of which breach either threshold):

| Function | logic_loc | depth | Justification |
|---|---:|---:|---|
| `_build_category_stats` | 137 | 2 | New shared per-class builder this plan created — carries the full WDL/conversion/recovery/eval/Score-Gap field derivation for one `EndgameCategoryStats`, replacing what were two ~130-line near-duplicate loop bodies (one per caller). Not flagged by any ruff rule; depth 2 throughout (no nested branching beyond simple if/else pairs). |
| `_get_endgame_performance_from_rows` | 127 | 4 | Pre-existing, untouched by this plan. Per 214-01's SUMMARY: "a single statistical pass"; not flagged by `C901`/`PLR0912`/`PLR0915`. |
| `get_endgame_overview` | 199 | 1 | Pre-existing, untouched by this plan. Per 214-01's SUMMARY: "a fetch-and-assemble orchestrator whose body is a sequence of awaited repository calls"; depth 1 (no nested branching at all), not flagged by any ruff rule. |

## Issues Encountered

None beyond the three design-time deviations documented above (caught before any code shipped with the bug, not after).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `app/services/endgame_service.py` carries no complexity exemption in `pyproject.toml`; `ruff check .` stays green project-wide with two fewer baselined files (`tactic_detector.py` from 214-02, `endgame_service.py` from this plan).
- The "shared accumulator with a caller-specific gating flag, plus each caller keeping its own row-shape dispatch when the raw shapes genuinely diverge" pattern is now proven on the phase's highest-risk file (a real, load-bearing behavior-preservation trap, not a hypothetical one) — 214-04..214-08 can reuse this when a candidate split has two callers with subtly different per-row semantics.
- Ready for the next wave-2 plan (214-04 through 214-07); no blockers. 214-08 exists in the phase directory but was not part of this plan's scope.

## Self-Check: PASSED

- `app/services/endgame_service.py` — FOUND on disk
- `pyproject.toml` — FOUND on disk, `endgame_service.py` per-file-ignores entry confirmed absent (`grep -c "endgame_service.py" pyproject.toml` → 0)
- Commits `9203c376a`, `176d5ce5a`, `5046cbf88` — all FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>`: `uv run pytest -n auto tests/test_endgame_service.py tests/services/test_endgame_service.py tests/test_aggregation_sanity.py tests/services/test_endgame_service_chip_decoupling.py -q` (372 passed), `uv run ruff check app/services/endgame_service.py` + `--config 'lint.per-file-ignores = {}'` + `uv run ruff check .` (all clean), `uv run python scripts/check_function_size.py app/services/endgame_service.py --fail-over-depth 4 --fail-over-loc 200` (OK, exit 0), `grep -v '^\s*#' app/services/endgame_service.py | grep -c 'sentry_sdk\.capture_exception('` (1), `uv run ty check app/ tests/ scripts/` (zero errors), `uv run ruff format --check app/ tests/ scripts/` (clean, 453 files), `uv run pytest -n auto -x -q` (4496 passed, 19 skipped)

---
*Phase: 214-backend-god-file-decomposition*
*Completed: 2026-09-02*
