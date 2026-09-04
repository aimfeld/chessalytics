---
phase: 214-backend-god-file-decomposition
plan: 07
subsystem: services
tags: [ruff, complexipy, insights-llm, refactor, golden-test, filter-then-render]

# Dependency graph
requires:
  - phase: 214-01
    provides: "ruff C901/PLR0912/PLR0915 enabled with a baselined per-file-ignores table; scripts/check_function_size.py"
  - phase: 214-03
    provides: "Tracer-task + mutation-proof method for a behavior-preservation split"
provides:
  - "app/services/insights_llm.py's single worst function by cognitive complexity (_assemble_user_prompt, was complexipy 48) now a thin filter-pipeline orchestrator (66 logic LOC, depth 2), with a byte-level golden-prompt test as the permanent oracle for future edits"
  - "The two near-duplicate ELO summary renderers share one implementation (_render_elo_variant_summary_block); _format_zone_bounds's depth-6 if/elif chain flattened to depth 2"
  - "app/services/insights_llm.py carries no ruff complexity exemption -- the sixth and last Phase 214 in-scope file to clear its per-file-ignores entry"
affects: [214-08]

# Actuals (#2632) -- chars/4 over the realized diff (git diff HEAD~3..HEAD for the
# four touched files), not a harness token count.
actuals:
  tokens: 16746
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Golden/snapshot test as the split oracle: a committed whole-string-equality fixture, captured from pre-refactor code, closes the gap substring assertions leave for reordering/dropped-blank-line/misordered-filter regressions -- first use of this pattern in Phase 214."
    - "Extract a nested closure to a module-level function to let ruff's C901 score it independently -- ruff folds a nested def's branches into the enclosing function's own complexity count, so deduplicating two near-identical functions into one shared function does NOT reduce complexity by itself if the shared body still nests its per-window logic in a closure."
    - "Flatten an if/elif/.../elif dispatch chain to sibling early-return `if` statements (same precedence order) to cut AST nesting depth -- each `elif` lives in the previous `If` node's `orelse`, so a long chain silently stacks one AST level per branch even though it reads as flat Python."
    - "Named filter-stage helpers can live at their REAL call site, not literally inside the orchestrator whose docstring names them -- a docstring's filter-stage list documents effects across the whole render pipeline, not necessarily inline steps in one function's body. See the deviation below."

key-files:
  modified:
    - app/services/insights_llm.py
    - pyproject.toml
    - tests/services/test_insights_llm.py
  created:
    - tests/services/golden/insights_user_prompt.txt

key-decisions:
  - "The plan's Task 2 literally required _apply_c2_filter/_apply_c3_filter/_apply_c4_filter/_apply_c5_filter/_apply_c6_filter to exist and be 'called from _assemble_user_prompt in the same order the inline stages ran' -- but only A2 is actually inline in _assemble_user_prompt's body. C2/C6 live inside _retained_series_for_summary, C3 lives inside _render_series_block, C5 lives inside _render_subsection_block's raw-series-emission loop, and C4 ('drop the scalar overall subsection when overall_wdl renders') is dead: the scalar overall subsection was already permanently removed from _SECTION_LAYOUT in a prior Phase 102 UAT pass, so there is no runtime branch left to gate. Extracted every real filter stage as a named _apply_<code>_filter helper AT ITS ACTUAL CALL SITE instead of forcing a risky hoist of deep per-row filtering logic up into the top-level orchestrator (which would itself be the kind of architectural change the phase's zero-behavior-change contract and 'don't split to fit a signature' guidance argue against). Did not create a no-op _apply_c4_filter for dead code -- updated the docstring instead to state C4 is retired."
  - "_assemble_user_prompt's actual depth-5/PLR0912-16 source was NOT the filter chain the docstring enumerates -- it was the per-section render loop's nested chart/subsection dispatch (_SECTION_LAYOUT iteration) plus two per-row prep loops (all_time_series_pairs, stale_markers/live_series_metrics). Extracted _render_layout_item, _compute_all_time_series_pairs, _compute_stale_markers_and_live_metrics -- this is what actually cleared both ruff findings on this function."
  - "Deduplicating _render_endgame_elo_summary_block/_render_non_endgame_elo_summary_block into one shared function did not by itself clear C901 17>15 on the shared body -- ruff counts a nested closure's branches toward the enclosing function. Had to also extract the per-window window_line() closure to a module-level _elo_variant_window_line before the shared _render_elo_variant_summary_block cleared the threshold."
  - "_apply_c6_filter's cap logic was duplicated between _retained_series_for_summary and _all_time_window_bounds before this plan (each independently sliced [-_ALL_TIME_MAX_POINTS:]). Consolidated into one shared helper used by both -- a small, safe dedup bonus beyond what either task literally asked for, since both call sites already needed the exact same slice."

requirements-completed: []

coverage:
  - id: D1
    description: "A committed byte-level golden holds the full LLM user prompt for a deterministic fixture (50-point all_time endgame_elo_gap series exceeding the 36-point C6 cap, a last_3mo counterpart exercising C5, a zone-bounded per-class metric), and one new test asserts whole-string equality; no existing test was modified"
    requirement: null
    verification:
      - kind: unit
        ref: "tests/services/test_insights_llm.py::TestGoldenUserPrompt::test_golden_user_prompt_matches_committed_file"
        status: pass
      - kind: other
        ref: "git diff -- tests/services/ for this plan contains only the added golden test and the added golden file"
        status: pass
    human_judgment: false
  - id: D2
    description: "_assemble_user_prompt is a filter-pipeline orchestrator inside max-branches=12 at nesting depth 4 or less (actual: 66 logic LOC, depth 2, zero ruff findings)"
    requirement: null
    verification:
      - kind: other
        ref: "uv run ruff check app/services/insights_llm.py --config 'lint.per-file-ignores = {}' (0 findings on _assemble_user_prompt)"
        status: pass
      - kind: other
        ref: "uv run python scripts/check_function_size.py app/services/insights_llm.py --fail-over-depth 4 --fail-over-loc 200 (OK: 60 functions scanned, no breaches)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The two ELO summary blocks share one implementation and are inside C901 15; _render_subsection_block, _format_player_profile_block, and _format_zone_bounds are inside their thresholds"
    requirement: null
    verification:
      - kind: other
        ref: "uv run ruff check app/services/insights_llm.py --config 'lint.per-file-ignores = {}' (0 findings, was 5: 490, 1420, 1549, 2026, 2192)"
        status: pass
      - kind: unit
        ref: "5-module insights oracle, 205 passed (was 204 pre-golden baseline + 1 golden test)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The file's per-file-ignores entry is deleted from pyproject.toml; ruff check . stays green project-wide"
    requirement: null
    verification:
      - kind: other
        ref: "uv run ruff check app/services/insights_llm.py && uv run ruff check app/services/insights_llm.py --config 'lint.per-file-ignores = {}' && uv run ruff check ."
        status: pass
      - kind: other
        ref: "uv run pytest -n auto -x -q (4497 passed, 19 skipped)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Mutation proof: stubbing _apply_c6_filter to skip the 36-point cap turns the golden test (and a pre-existing test) red; restoring returns the suite to green"
    requirement: null
    verification:
      - kind: unit
        ref: "tests/services/test_insights_llm.py -- 2 failed with the mutation (TestGoldenUserPrompt + TestPromptAssembly::test_all_time_series_trimmed_to_last_36_points), 205 passed restored"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-09-03
status: complete
---

# Phase 214 Plan 07: LLM Prompt Assembler Split Summary

**A byte-level golden test now guards `_assemble_user_prompt`'s output; the function itself dropped from complexipy 48 / PLR0912 16 / depth 5 to a 66-logic-LOC filter-pipeline orchestrator, and every other ruff-flagged function in `insights_llm.py` (both ELO summary renderers, `_render_subsection_block`, `_format_player_profile_block`, `_format_zone_bounds`'s depth-6 dispatch) is now clean -- the last of Phase 214's six in-scope files to lose its complexity exemption.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-09-03T04:34:42Z
- **Tasks:** 3
- **Files modified:** 4 (1 created: golden file; 3 modified: insights_llm.py, test_insights_llm.py, pyproject.toml)

## Accomplishments

- `tests/services/golden/insights_user_prompt.txt` (83 lines) -- a whole-string oracle for `_assemble_user_prompt`, captured from pre-refactor code against a purpose-built deterministic fixture that exercises: a 50-point `all_time` `endgame_elo_gap` series (exceeding the 36-point C6 cap so the cap has real points to drop), a `last_3mo` counterpart for the same (metric, subsection) pair (exercises C5's skip-when-all_time-exists gate and the ELO-summary dedup target), and a zone-bounded `endgame_type_achievable_score_gap` finding. `TestGoldenUserPrompt::test_golden_user_prompt_matches_committed_file` asserts byte equality.
- `_apply_a2_filter`, `_apply_c2_filter`, `_apply_c3_filter`, `_apply_c5_filter`, `_apply_c6_filter` -- five of the docstring's six named filter stages extracted as real, single-purpose helpers, each at its actual call site (see the deviation below for why C4 has no code left to extract, and why the other four don't literally live inside `_assemble_user_prompt`'s own body).
- `_assemble_user_prompt` itself: extracted `_render_layout_item` (one `_SECTION_LAYOUT` entry -> `list[str]`, fixing the real depth-5 source), `_compute_all_time_series_pairs`, and `_compute_stale_markers_and_live_metrics` (the two per-row prep loops). Dropped from complexipy 48 / PLR0912 16 / depth 5 to complexipy 8 / 0 ruff findings / depth 2 / 66 logic LOC.
- `_render_endgame_elo_summary_block` / `_render_non_endgame_elo_summary_block` (were C901 17 each, byte-identical apart from the header label and per-bucket extractor) now share one `_render_elo_variant_summary_block` implementation, itself parameterized by `label`/`per_bucket`; both original names stay as thin wrappers so `_render_subsection_block`'s call sites and any test import keep working unchanged.
- `_format_player_profile_block` (PLR0912 13) split into `_render_player_profile_entry` (per-combo block) and `_player_profile_anchor_tag` (the leading tag).
- `_format_zone_bounds` (nesting depth 6, the deepest function in the whole phase) flattened from a stacked if/elif/.../elif dispatch to sibling early-return `if` statements at the same precedence order, via a new `_render_zone_spec` tail-formatting helper. Now depth 2.
- `pyproject.toml`'s `app/services/insights_llm.py` per-file-ignores entry deleted -- `ruff check .` stays green project-wide with zero of Phase 214's six in-scope files still exempted.
- Sentry capture site count stays exactly 3 throughout (verified after every task).

## Task Commits

Each task was committed atomically:

1. **Task 1: Capture a golden user prompt, then extract the first filter stage** -- `23c654828` (feat) -- tracer task; tracer feedback gate applied per row 3 (interactive, `end-of-phase`, `<verify>` carried only `<automated>`): re-ran the golden test twice for determinism, confirmed pass, proceeded to Task 2 without a checkpoint.
2. **Task 2: Finish the prompt-assembly filter pipeline** -- `170ede45c` (feat)
3. **Task 3: Dedup ELO summary blocks, flatten depth-6, mutation proof, ignore-entry deletion** -- `4d762297f` (fix)

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

## Files Created/Modified

- `tests/services/golden/insights_user_prompt.txt` -- new: 83-line byte-level golden prompt.
- `tests/services/test_insights_llm.py` -- new `TestGoldenUserPrompt` class (fixture builder + one equality test); no existing test body modified.
- `app/services/insights_llm.py` -- `_apply_a2_filter`, `_apply_c2_filter`, `_apply_c3_filter`, `_apply_c5_filter`, `_apply_c6_filter`, `_compute_all_time_series_pairs`, `_compute_stale_markers_and_live_metrics`, `_render_layout_item`, `_group_findings_by_metric_dim`, `_render_elo_variant_summary_block`, `_elo_variant_window_line`, `_render_player_profile_entry`, `_player_profile_anchor_tag`, `_render_zone_spec` added; `_assemble_user_prompt`, `_retained_series_for_summary`, `_all_time_window_bounds`, `_render_series_block`, `_render_subsection_block`, `_format_player_profile_block`, `_format_zone_bounds`, `_render_endgame_elo_summary_block`, `_render_non_endgame_elo_summary_block` bodies reduced to orchestration over the new helpers (the last two are now thin wrappers). All ten pinned names (`_PROMPT_VERSION`, `_maybe_strip_overview`, `get_insights_agent`, `_assemble_user_prompt`, `_render_series_block`, `_render_subsection_block`, `_format_zone_bounds`, `_format_rating_basis_block`, `_format_time_pressure_score_gap_chart_block`, `_NO_BAND_METRICS`) still resolve as module attributes.
- `pyproject.toml` -- deleted the `app/services/insights_llm.py` per-file-ignores entry.

## Decisions Made

See `key-decisions` in frontmatter: (1) real filter-stage call sites vs. the plan's literal "called from `_assemble_user_prompt`" text, with C4 documented as retired dead code rather than a fabricated no-op; (2) `_assemble_user_prompt`'s actual complexity source was the render loop + prep loops, not the filter chain; (3) deduplication alone didn't clear C901 on the shared ELO block -- the nested closure had to move to module level too; (4) `_apply_c6_filter` consolidated across its two call sites as a dedup bonus.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Plan/code mismatch] Task 2's literal filter-stage extraction target does not match the actual code structure**
- **Found during:** Task 2, before writing any code -- traced where C2/C3/C4/C5/C6 actually execute by grepping every `C2:`/`C3:`/etc. comment in the file.
- **Issue:** The plan's Task 2 action and acceptance criteria require `_apply_c2_filter` through `_apply_c6_filter` to exist AND be "called from `_assemble_user_prompt` in the same order the inline stages ran." Reality: only A2 (the NaN/thin/pawnless drop) is inline in `_assemble_user_prompt`'s own body. C2 (90-day overlap trim) and C6 (36-point cap) execute inside `_retained_series_for_summary`, called from `_render_subsection_block`, two call levels below `_assemble_user_prompt`. C3 (activity-gap markers) executes inside `_render_series_block`, three levels below. C5 (skip superseded last_3mo series) executes inside `_render_subsection_block`'s raw-series-emission loop. C4 ("drop the scalar `overall` subsection when overall_wdl renders") corresponds to NO live code at all -- the scalar `overall` subsection was already permanently removed from `_SECTION_LAYOUT` in a prior Phase 102 UAT pass (comment at that line explicitly says so), so there is no runtime branch left to gate. The docstring's filter-stage list documents effects across the whole render pipeline (of which `_assemble_user_prompt` is the entry point), not literal inline steps in one function's body -- a plan-authoring assumption RESEARCH.md itself flagged as unverified (Assumption A1: "I did not read all 117 test bodies").
- **Fix:** Extracted every REAL filter stage as a named `_apply_<code>_filter` helper at its actual call site: `_apply_c2_filter`/`_apply_c6_filter` inside `_retained_series_for_summary` (and `_apply_c6_filter` reused by `_all_time_window_bounds`, eliminating a pre-existing duplication); `_apply_c3_filter` inside `_render_series_block`; `_apply_c5_filter` inside `_render_subsection_block`'s raw-series loop. Did NOT fabricate a no-op `_apply_c4_filter` for dead code -- updated `_assemble_user_prompt`'s docstring to state C4 is retired and name each surviving stage's real call site instead. `_assemble_user_prompt`'s own actual PLR0912/depth-5 source (the `_SECTION_LAYOUT` render loop's nested chart/subsection dispatch, plus two per-row prep loops) was fixed via `_render_layout_item`/`_compute_all_time_series_pairs`/`_compute_stale_markers_and_live_metrics` -- extractions the plan's Task 2 text didn't name but that are what actually cleared the two real ruff findings on that function.
- **Files modified:** `app/services/insights_llm.py`
- **Verification:** All five real `_apply_<code>_filter` helpers exist with explicit return types; `_assemble_user_prompt` is 0 ruff findings, depth 2, 66 logic LOC; the golden test (byte-identical prompt) and the full 205-test oracle both pass; the mutation proof (below) proves `_apply_c6_filter` is load-bearing, not decorative.
- **Committed in:** `170ede45c` (Task 2), `4d762297f` (Task 3, C5/C4 docstring finalization)

**2. [Rule 1 - Bug] Deduplicating the ELO summary blocks alone did not clear C901 17>15**
- **Found during:** Task 3, immediately after the first dedup pass (shared body, still with a nested `window_line` closure)
- **Issue:** `uv run ruff check` still flagged the new shared `_render_elo_variant_summary_block` at C901 17 -- identical to the pre-dedup count on either original function. Ruff's mccabe complexity counts a nested closure's own decision points toward the ENCLOSING function, so merging two functions with the same closure into one function with one (still nested) closure changes nothing about the complexity score.
- **Fix:** Extracted the nested `window_line` closure to a module-level `_elo_variant_window_line` function (taking `per_bucket`/`stale_markers` as explicit parameters instead of closing over them). Ruff then scores it independently; both the shared block function and the new module-level function clear C901 15.
- **Files modified:** `app/services/insights_llm.py`
- **Verification:** `uv run ruff check app/services/insights_llm.py --config 'lint.per-file-ignores = {}'` clean; 205-test oracle unchanged; golden byte-identical.
- **Committed in:** `4d762297f` (Task 3)

**3. [Rule 3 - Blocking] ty could not narrow `candidate_finding`/`candidate_series` across the new `_apply_c5_filter` call boundary**
- **Found during:** Task 2, `uv run ty check` after extracting `_apply_c5_filter`
- **Issue:** The original inline `if candidate_finding is None or not candidate_series: continue` let ty narrow both variables to non-`None` for the rest of the loop body. Moving that check into `_apply_c5_filter` (a separate function call) removed ty's ability to narrow across the call boundary, so the subsequent `_render_series_block(candidate_finding, candidate_series)` call failed `invalid-argument-type`.
- **Fix:** Added two explicit `assert candidate_finding is not None` / `assert candidate_series is not None` statements immediately after the `if not _apply_c5_filter(...): continue` guard, with a comment explaining why (ty cannot narrow through a function-call boundary the way it could an inline check). No `# ty: ignore` needed.
- **Files modified:** `app/services/insights_llm.py`
- **Verification:** `uv run ty check app/ tests/ scripts/` reports zero errors.
- **Committed in:** `170ede45c` (Task 2)

---

**Total deviations:** 3 auto-fixed (1 plan/code-mismatch requiring a full re-derivation of Task 2's extraction targets, 1 dedup-didn't-clear-the-gate bug caught before the commit landed, 1 ty type-narrowing fix).
**Impact on plan:** Deviation 1 is the substantial one -- it changes WHERE five of the six filter-stage helpers live relative to the plan's literal text, while preserving every locked invariant the plan actually tests for (byte-identical golden, pinned names, Sentry count, no sibling module, filter order/semantics unchanged, ignore-entry deleted, mutation proof passes). No scope creep: no new files beyond the golden, no architectural change, no test rewritten.

## Mutation Proof (recorded per Task 3)

Temporarily replaced `_apply_c6_filter`'s body with `return points` (skipping the 36-point tail cap). Result: 2 of 205 tests failed --

```
FAILED tests/services/test_insights_llm.py::TestPromptAssembly::test_all_time_series_trimmed_to_last_36_points
FAILED tests/services/test_insights_llm.py::TestGoldenUserPrompt::test_golden_user_prompt_matches_committed_file
2 failed, 203 passed in 22.96s
```

The golden test's diff showed exactly the expected effect: the payload-summary window line changed from `2023-03 → 2026-02` (36 capped points) to `2022-01 → 2026-02` (all 50 points), and the `[series endgame_elo_gap, ...]` block emitted 50 point-lines instead of 36. Restored the original body: `205 passed` (green again). This confirms the golden file is a real discriminating oracle for the C6 stage, not merely a passive snapshot that happens to match.

## Complexipy Before/After (this file)

- **Before (214-01 baseline):** 12 functions over cognitive complexity 15 (`insights_llm.py` row in the 214-01 SUMMARY's per-file table).
- **After:** 9 functions over cognitive complexity 15 -- `_assemble_user_prompt` (was 48), `_render_endgame_elo_summary_block` (was 39), `_render_non_endgame_elo_summary_block` (was 39) no longer appear on the list. The remaining 9 (`_elo_variant_window_line`=16, `_format_time_pressure_score_gap_chart_block`=17, `_render_series_block`=18, `_asymmetry_lines`=20, `_summary_window_line`=20, `_all_time_window_bounds`=22, `_format_zone_bounds`=23, `_format_rating_basis_block`=24, `_render_subsection_block`=24) are expected and acceptable -- complexipy stays report-only per 214-01's decision (not CI-gated). The branch-count gate (`PLR0912`, which IS gated) and the nesting-depth gate (`check_function_size.py`, also gated) are both clean for every function in this file, including `_format_zone_bounds` and `_render_subsection_block` despite their complexipy scores -- cognitive complexity (nesting-weighted) and cyclomatic/branch-count are genuinely different metrics, and this file's remaining complexipy hits are branch-DENSE-but-shallow functions (e.g. `_format_zone_bounds`'s long boolean conditions, now at depth 2) rather than deeply nested ones.

## 100-200 Logic-LOC Survivors

`scripts/check_function_size.py --json` on this file (`--fail-over-loc 200 --fail-over-depth 4` exits 0; the listing below is every function between 100 and 200 logic LOC, none of which breach either threshold):

| Function | logic_loc | depth | Justification |
|---|---:|---:|---|
| `_render_subsection_block` | 114 | 3 | Pre-existing, not itself split further this plan (was already brought under `PLR0912` by extracting `_group_findings_by_metric_dim` and `_apply_c5_filter`). Combines the header/inline-tag block + the `(metric, dim_key)`-grouped `[summary]`/`[series]` emission loop for one subsection; not flagged by any gated rule (0 ruff findings, depth 3, well under the 200-LOC ceiling). |

For comparison, `_assemble_user_prompt` -- the plan's primary target and the phase's single worst function by cognitive complexity going in (complexipy 48, PLR0912 16, depth 5) -- is now 66 logic LOC / depth 2, well below the 100-LOC survivor band.

## Issues Encountered

None beyond the plan/code-mismatch and ty-narrowing deviations documented above (both caught and resolved before any code shipped with the bug).

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `app/services/insights_llm.py` carries no complexity exemption in `pyproject.toml` -- `ruff check .` stays green project-wide. All six of Phase 214's in-scope files (`tactic_detector.py`, `endgame_service.py`, `library_repository.py`, `eval_apply.py`, `train_repository.py`, `insights_llm.py`) are now clean.
- The "docstring names a filter/behavior chain that documents effects across a whole pipeline, not literal inline steps in one function" trap is now a proven pattern-to-check for future god-file plans: before extracting a "named stage" from a function, grep for where the constant/comment actually fires in the code, not just where the docstring lists it.
- The "extract nested closures to module level before deduplicating two near-identical functions" pattern is now proven -- ruff's C901 does not score a nested `def` independently of its enclosing function.
- 214-08 is the phase's remaining plan (wave 3 closeout / final verification across all six split files); no blockers from this plan.

## Self-Check: PASSED

- `app/services/insights_llm.py` -- FOUND on disk
- `tests/services/golden/insights_user_prompt.txt` -- FOUND on disk (83 lines, non-empty)
- `pyproject.toml` -- FOUND on disk, `insights_llm.py` per-file-ignores entry confirmed absent (`grep -c "insights_llm.py" pyproject.toml` inside `[tool.ruff.lint.per-file-ignores]` -> 0)
- Commits `23c654828`, `170ede45c`, `4d762297f` -- all FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>`: `uv run pytest -n auto tests/services/test_insights_llm.py tests/test_insights_router.py tests/services/test_insights_service_series.py tests/test_insights_llm_thinking.py tests/services/test_endgame_zones.py -q` (205 passed), `uv run ruff check app/services/insights_llm.py` + `--config 'lint.per-file-ignores = {}'` + `uv run ruff check .` (all clean), `uv run python scripts/check_function_size.py app/services/insights_llm.py --fail-over-depth 4 --fail-over-loc 200` (OK, exit 0), `python3 -c "import app.services.insights_llm as m; [getattr(m, n) for n in (...)]"` (all 10 pinned names resolve), `grep -v '^\s*#' app/services/insights_llm.py | grep -c 'sentry_sdk\.capture_exception('` (3), `uv run ty check app/ tests/ scripts/` (zero errors), `uv run ruff format --check app/ tests/ scripts/` (clean, 453 files), `uv run pytest -n auto -x -q` (4497 passed, 19 skipped)

---
*Phase: 214-backend-god-file-decomposition*
*Completed: 2026-09-03*
