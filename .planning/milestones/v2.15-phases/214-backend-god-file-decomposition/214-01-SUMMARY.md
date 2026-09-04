---
phase: 214-backend-god-file-decomposition
plan: 01
subsystem: infra
tags: [ruff, complexipy, ast, tooling, ty]

# Dependency graph
requires: []
provides:
  - "ruff C901/PLR0912/PLR0915 enabled project-wide with a baselined per-file-ignores table"
  - "scripts/check_function_size.py -- AST nesting-depth + logic-LOC gate with unit tests"
  - "complexipy dev dependency for cognitive-complexity reporting"
  - "docs/dev-tooling.md and CLAUDE.md document all three tools"
affects: [214-02, 214-03, 214-04, 214-05, 214-06, 214-07]

# Actuals (#2632)
actuals:
  tokens: 33000
  tasks: 3
  commits: 5

# Tech tracking
tech-stack:
  added: [complexipy 7.0.1 (dev dependency)]
  patterns:
    - "AST walker with scope-boundary skip (nested def/class starts a fresh depth-0 record)"
    - "try/except counted as one nesting level per handler, not two"
    - "pragma-based opt-out (# check-function-size: allow-loc <reason>) for literal-heavy functions, LOC only, never depth"

key-files:
  created:
    - scripts/check_function_size.py
    - tests/scripts/test_check_function_size.py
  modified:
    - pyproject.toml
    - uv.lock
    - docs/dev-tooling.md
    - CLAUDE.md

key-decisions:
  - "Baselined 10 additional out-of-app/ files (17 more ruff findings in alembic/, analysis/, scripts/) beyond the plan's app/-scoped measurement -- `ruff check .` scans the whole repo, so the plan's 35-finding/14-file baseline was incomplete for a green project-wide gate. Full baseline: 52 findings across 24 files."
  - "logic_loc excludes the def/signature line itself, not just docstring/blank/comment lines -- 'body lines' in the behavior spec means lines after the signature."
  - "Did not gate CI on complexipy (per plan) -- report-only, since ~85 of 97 app-wide breaches are outside this phase's six files."

requirements-completed: []

coverage:
  - id: D1
    description: "Ruff C901/PLR0912/PLR0915 enabled project-wide; every pre-existing breach (52 findings, 24 files, measured this session) baselined via per-file-ignores; ruff check . exits 0"
    verification:
      - kind: other
        ref: "uv run ruff check ."
        status: pass
      - kind: other
        ref: "uv run ruff check . --config 'lint.per-file-ignores = {}' --output-format concise | grep -cE 'C901|PLR0912|PLR0915' (52)"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/check_function_size.py -- stdlib-only AST nesting-depth + logic-LOC gate, unit tested, exits 1 on breach"
    verification:
      - kind: unit
        ref: "tests/scripts/test_check_function_size.py (18 tests)"
        status: pass
      - kind: other
        ref: "uv run ty check app/ tests/ scripts/"
        status: pass
    human_judgment: false
  - id: D3
    description: "complexipy installed as a real dev dependency, all three tools documented in docs/dev-tooling.md and CLAUDE.md"
    verification:
      - kind: other
        ref: "uv run complexipy --version (7.0.1, no --with)"
        status: pass
      - kind: other
        ref: "grep -c check_function_size docs/dev-tooling.md; grep -c complexipy docs/dev-tooling.md CLAUDE.md"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-09-02
status: complete
---

# Phase 214 Plan 01: Complexity Tooling Baseline Summary

**Ruff C901/PLR0912/PLR0915 enabled project-wide with a 52-finding/24-file baseline, a new stdlib-only `scripts/check_function_size.py` AST gate for nesting depth + logic LOC, and `complexipy` as a real dev dependency — all three tools documented and ready for plans 214-02..214-07 to consume.**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-09-02T19:51:51Z
- **Tasks:** 3
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `[tool.ruff.lint] extend-select = ["C901", "PLR0912", "PLR0915"]` (mccabe max-complexity=15, pylint max-branches=12/max-statements=100) enabled project-wide; `uv run ruff check .` is green with every pre-existing breach baselined via `per-file-ignores`.
- `scripts/check_function_size.py` — stdlib-only AST walker (no new dependency) reporting per-function `raw_loc`, `logic_loc`, `max_nesting_depth`, with a `# check-function-size: allow-loc <reason>` pragma for LOC-only exemptions; 18 unit tests cover every behavior bullet in the plan (nesting depth, try/except-as-one-level, nested-def isolation, comprehension exclusion, docstring/blank/comment exclusion, pragma exemption, exit code, directory walk).
- `complexipy` added to the existing `dev` dependency group (no new isolated group); app-wide baseline recorded (97 functions over cognitive complexity 15).
- `docs/dev-tooling.md` and `CLAUDE.md` document all three tools with runnable commands.

## Task Commits

Each task was committed atomically:

1. **Task 1: Enable C901/PLR0912/PLR0915 with a measured baseline** — `28ab52533` (feat)
2. **Task 2 RED: failing test for check_function_size** — `2fa1cbdea` (test)
3. **Task 2 RED fix: corrected miscounted depth in own test fixture** — `0970bca1b` (fix)
4. **Task 2 GREEN: check_function_size implementation** — `d89df6f22` (feat)
5. **Task 3: complexipy dependency, tool docs, app-wide baseline** — `ec4e88dc2` (feat)

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

_Task 2 was TDD (`tdd="true"`): RED (`2fa1cbdea`) → RED-fix (`0970bca1b`, a bug in my own test assertion, caught before writing the implementation) → GREEN (`d89df6f22`). No REFACTOR commit — the GREEN implementation needed no cleanup._

## Files Created/Modified

- `scripts/check_function_size.py` — new: `FunctionRecord` dataclass, `iter_python_files`, `max_nesting_depth`, `logic_loc`, `scan_source`, `scan_file`, `main`; CLI `--fail-over-depth`/`--fail-over-loc`/`--json`.
- `tests/scripts/test_check_function_size.py` — new: 18 unit tests covering the full `<behavior>` spec.
- `pyproject.toml` — `[tool.ruff.lint]`/`[tool.ruff.lint.mccabe]`/`[tool.ruff.lint.pylint]` added; 24 new `per-file-ignores` entries (14 in `app/`, 10 outside it); `complexipy` added to `[dependency-groups] dev`.
- `uv.lock` — regenerated by `uv add --dev complexipy`.
- `docs/dev-tooling.md` — three new bullets: `check_function_size.py`, the ruff complexity rules, `complexipy`.
- `CLAUDE.md` — function-size bullet now names all three tools and points at `docs/dev-tooling.md`.

## Decisions Made

- **Extended the baseline beyond the plan's app/-only scope.** The plan's measurement command (`ruff check --select ... app/`) found 35 findings across 14 files, and the acceptance criteria's exact verify command expected that number after emptying `per-file-ignores`. But `uv run ruff check .` (the acceptance criteria's actual gate, no `app/` scoping) walks the entire repo, and running it after adding the `[tool.ruff.lint]` block surfaced 17 more findings across 10 files in `alembic/versions/`, `analysis/`, and `scripts/` that the plan's app/-scoped measurement never saw. Left unbaselined, `ruff check .` would have failed on day one for files nobody in this phase is touching — the same failure mode the plan explicitly warns about for the 8 out-of-scope `app/` files, just missed for files outside `app/` entirely. Added baseline entries for all 10 additional files (measured, not estimated); full repo-wide baseline is 52 findings / 24 files. Documented as a Rule 1 deviation below.
- **`logic_loc` excludes the function's own `def`/signature line**, not just docstring/blank/comment lines. The plan's `<behavior>` says logic_loc "counts the remaining body lines" — read literally, the signature line is not a body line. Caught via my own test (`test_logic_loc_excludes_blank_comment_and_docstring_lines`) failing 3 vs expected 2 during GREEN.
- **complexipy stays report-only, not CI-gated** — per plan/ROADMAP: ~85 of the 97 app-wide breaches are outside this phase's six files, so gating would fail CI for unrelated work.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Baselined 17 additional out-of-app/ ruff findings the plan's measurement missed**
- **Found during:** Task 1 (after applying the plan's exact `pyproject.toml` config, `uv run ruff check .` still failed with 17 errors)
- **Issue:** The plan's action step measured the baseline scoped to `app/` only (`... app/ --output-format concise`, 35 findings / 14 files), and the acceptance criteria's `uv run ruff check .` — unscoped, whole-repo — was expected to then exit 0. Running it after the config change surfaced 17 more findings in `alembic/versions/`, `analysis/`, and `scripts/` (10 files) that the app/-scoped measurement never covered, so the gate was red.
- **Fix:** Measured the additional breaches (`uv run ruff check . --config 'lint.per-file-ignores = {}' --output-format concise`, whole repo) and added one `per-file-ignores` entry per additional file, grouped under its own comment header explaining the scope gap. Full repo-wide baseline: 52 findings, 24 files.
- **Files modified:** `pyproject.toml`
- **Verification:** `uv run ruff check .` exits 0; `uv run ruff check . --config 'lint.per-file-ignores = {}' --output-format concise | grep -cE 'C901|PLR0912|PLR0915'` now prints 52 (not the plan's expected 35 — see acceptance-criteria note below)
- **Committed in:** `28ab52533` (Task 1 commit)

**2. [Rule 1 - Bug] Fixed a miscounted depth assertion in my own RED test**
- **Found during:** Task 2, preparing to implement GREEN
- **Issue:** The `test_nested_def_does_not_inflate_outer_depth` fixture nested `if -> for -> if` inside the inner function (3 levels) but asserted `max_nesting_depth == 2`.
- **Fix:** Simplified the inner-function fixture to `if -> for` (2 levels) to match the correct expected depth.
- **Files modified:** `tests/scripts/test_check_function_size.py`
- **Verification:** Confirmed the test still failed for the same reason (`ModuleNotFoundError`, not an assertion error) before and after the fix, so RED discipline held.
- **Committed in:** `0970bca1b` (separate fix commit, before GREEN)

**3. [Rule 1 - Bug] logic_loc excluded the def line to match the "body lines" spec**
- **Found during:** Task 2 GREEN, first test run (`test_logic_loc_excludes_blank_comment_and_docstring_lines` failed 3 vs expected 2)
- **Issue:** Initial implementation counted the function's `def` line itself as a logic line, inflating the count by one.
- **Fix:** `logic_loc` now starts counting from `def_line + 1`.
- **Files modified:** `scripts/check_function_size.py`
- **Verification:** All 18 tests pass.
- **Committed in:** `d89df6f22` (Task 2 GREEN commit)

**4. [Rule 3 - Blocking] ty type-narrowing failure on a tuple-typed isinstance check**
- **Found during:** Task 2 GREEN, `uv run ty check`
- **Issue:** `isinstance(child, _FUNCTION_DEF_TYPES)` where `_FUNCTION_DEF_TYPES: tuple[type[ast.AST], ...]` did not narrow `child`'s type for `ty`, so `child.name` and the `_build_record` call both errored.
- **Fix:** Replaced the tuple-constant isinstance check with an inline `isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))`, which `ty` narrows correctly; removed the now-unused `_FUNCTION_DEF_TYPES` constant.
- **Files modified:** `scripts/check_function_size.py`
- **Verification:** `uv run ty check app/ tests/ scripts/` reports zero errors.
- **Committed in:** `d89df6f22` (Task 2 GREEN commit)

---

**Total deviations:** 4 auto-fixed (1 blocking-config-gap, 3 bugs — 2 in my own test, 1 in the implementation, 1 ty type-narrowing fix bundled with the implementation fix).
**Impact on plan:** All auto-fixes were necessary for the plan's own success criteria (`ruff check .` green project-wide, tests passing, ty clean) — no scope creep. The out-of-app/ baseline extension (deviation 1) is the only one that changes what ships beyond the plan's literal text; it does not touch any `app/` file or change behavior, only extends the same per-file-ignore pattern the plan already used for its 8 out-of-scope `app/` files to 10 more files elsewhere in the repo.

## Issues Encountered

- **Acceptance criteria number mismatch (documented, not silently overridden).** The plan's task 1 acceptance criteria state the ignore-emptied count should print "the count you measured in step 1 (35 at planning time)". Because the verify command it names (`uv run ruff check . --config 'lint.per-file-ignores = {}' ...`) is unscoped (whole repo, not `app/`), and the plan's own measurement command WAS scoped to `app/`, these two are inherently inconsistent for a project that has complexity breaches outside `app/` (which it does — 10 files). The measured, correct project-wide count is 52, and that is what the live command now reports. This is recorded here as an issue rather than silently "matching" a number that would have required leaving 17 real breaches unbaselined.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- All three complexity tools (`ruff` rules, `scripts/check_function_size.py`, `complexipy`) are live, tested, documented, and green project-wide.
- Plans 214-02..214-07 can now delete their file's `per-file-ignores` entry as proof of completion and use `scripts/check_function_size.py`/`complexipy` to measure their split's before/after numbers.
- Recorded before-baselines for the six in-scope files (below) are the reference point every later plan should improve on.

### Verbatim baselines for the SUMMARY (as required by the plan's `<output>`)

**Task 1 — ruff `app/`-scoped measurement (35 findings, 14 files, matches 214-RESEARCH.md exactly):**
```
app/main.py:94:11: PLR0912 Too many branches (15 > 12)
app/repositories/library_repository.py:527:5: PLR0912 Too many branches (13 > 12)
app/repositories/openings_repository.py:60:5: PLR0912 Too many branches (13 > 12)
app/repositories/query_utils.py:152:5: C901 `apply_game_filters` is too complex (17 > 15)
app/repositories/query_utils.py:152:5: PLR0912 Too many branches (17 > 12)
app/repositories/train_repository.py:1705:11: PLR0912 Too many branches (15 > 12)
app/services/chesscom_client.py:203:11: C901 `fetch_chesscom_games` is too complex (20 > 15)
app/services/chesscom_client.py:203:11: PLR0912 Too many branches (23 > 12)
app/services/chesscom_client.py:375:11: PLR0912 Too many branches (13 > 12)
app/services/endgame_service.py:397:5: C901 `_aggregate_endgame_stats` is too complex (25 > 15)
app/services/endgame_service.py:397:5: PLR0912 Too many branches (30 > 12)
app/services/endgame_service.py:397:5: PLR0915 Too many statements (145 > 100)
app/services/endgame_service.py:783:5: C901 `_aggregate_endgame_stats_by_tc` is too complex (21 > 15)
app/services/endgame_service.py:783:5: PLR0912 Too many branches (23 > 12)
app/services/endgame_service.py:783:5: PLR0915 Too many statements (109 > 100)
app/services/endgame_service.py:2106:5: PLR0912 Too many branches (15 > 12)
app/services/endgame_service.py:2596:5: C901 `_compute_per_tc_metric_cards` is too complex (16 > 15)
app/services/endgame_service.py:2596:5: PLR0912 Too many branches (17 > 12)
app/services/eval_apply.py:2074:11: C901 `_build_best_move_candidates` is too complex (18 > 15)
app/services/eval_apply.py:2074:11: PLR0912 Too many branches (18 > 12)
app/services/insights_llm.py:490:5: PLR0912 Too many branches (13 > 12)
app/services/insights_llm.py:1420:5: C901 `_render_endgame_elo_summary_block` is too complex (17 > 15)
app/services/insights_llm.py:1549:5: C901 `_render_non_endgame_elo_summary_block` is too complex (17 > 15)
app/services/insights_llm.py:2026:5: PLR0912 Too many branches (13 > 12)
app/services/insights_llm.py:2192:5: PLR0912 Too many branches (16 > 12)
app/services/library_service.py:145:5: C901 `_build_eval_series` is too complex (19 > 15)
app/services/library_service.py:145:5: PLR0912 Too many branches (22 > 12)
app/services/lichess_client.py:51:11: C901 `fetch_lichess_games` is too complex (20 > 15)
app/services/lichess_client.py:51:11: PLR0912 Too many branches (20 > 12)
app/services/normalization.py:341:5: PLR0912 Too many branches (13 > 12)
app/services/position_classifier.py:188:5: C901 `_mixedness_score` is too complex (16 > 15)
app/services/position_classifier.py:188:5: PLR0912 Too many branches (16 > 12)
app/services/tactic_detector.py:1968:5: PLR0912 Too many branches (13 > 12)
app/services/tactic_detector.py:2413:5: C901 `detect_tactic_motif` is too complex (22 > 15)
app/services/tactic_detector.py:2413:5: PLR0912 Too many branches (20 > 12)
Found 35 errors.
```

**Additional out-of-app/ findings baselined (17, 10 files — deviation 1 above):**
```
alembic/versions/20260403_203535_adfafb71bacc_repair_bookmark_fens_and_target_hashes.py:48:5: C901 `upgrade` is too complex (22 > 15)
alembic/versions/20260403_203535_adfafb71bacc_repair_bookmark_fens_and_target_hashes.py:48:5: PLR0912 Too many branches (24 > 12)
analysis/engine_disagreement_study/seed153_tail_analysis.py:518:5: PLR0915 Too many statements (161 > 100)
analysis/engine_disagreement_study/seed153_tail_analysis.py:518:5: C901 `render` is too complex (20 > 15)
analysis/engine_disagreement_study/seed153_tail_analysis.py:518:5: PLR0912 Too many branches (23 > 12)
scripts/archive/backfill_best_move_pv.py:370:11: PLR0912 Too many branches (13 > 12)
scripts/archive/backfill_eval.py:554:11: PLR0912 Too many branches (14 > 12)
scripts/backfill_flaws.py:112:11: C901 `run_backfill` is too complex (17 > 15)
scripts/backfill_flaws.py:112:11: PLR0912 Too many branches (16 > 12)
scripts/engine_disagreement_study/seed153_verify_manifest.py:60:5: PLR0912 Too many branches (14 > 12)
scripts/import_benchmark_users.py:586:11: C901 `main` is too complex (18 > 15)
scripts/import_benchmark_users.py:586:11: PLR0912 Too many branches (18 > 12)
scripts/import_stress_monitor.py:352:5: PLR0912 Too many branches (14 > 12)
scripts/retag_flaws.py:621:11: C901 `run_backfill` is too complex (18 > 15)
scripts/retag_flaws.py:621:11: PLR0912 Too many branches (19 > 12)
scripts/two_pawns_up/gen_report_v2.py:587:5: C901 `render_basis` is too complex (21 > 15)
scripts/two_pawns_up/gen_report_v2.py:587:5: PLR0912 Too many branches (20 > 12)
Found 17 errors.
```

**Full repo-wide total (ignore table emptied):** 52 findings, 24 files.

**Task 3 — complexipy app-wide baseline:** 97 functions over cognitive complexity 15 (matches 214-RESEARCH.md exactly).

**Task 3 — complexipy per-file counts (six in-scope files, matches 214-RESEARCH.md exactly):**

| File | Functions >15 |
|------|---:|
| `endgame_service.py` | 12 |
| `train_repository.py` | 5 |
| `eval_apply.py` | 8 |
| `library_repository.py` | 3 |
| `insights_llm.py` | 12 |
| `tactic_detector.py` | 16 |

**Task 3 — `check_function_size.py --fail-over-depth 4 --fail-over-loc 200` per in-scope file:**

```
app/services/endgame_service.py:397: _aggregate_endgame_stats -- logic_loc 251 > 200
app/services/endgame_service.py:783: _aggregate_endgame_stats_by_tc -- depth 5 > 4
app/services/endgame_service.py:2596: _compute_per_tc_metric_cards -- depth 5 > 4
-> exit 1

app/repositories/train_repository.py:
OK: 33 functions scanned, no breaches
-> exit 0

app/services/eval_apply.py:
OK: 41 functions scanned, no breaches
-> exit 0

app/repositories/library_repository.py:1960: fetch_flaw_comparison -- logic_loc 243 > 200
-> exit 1

app/services/insights_llm.py:363: _format_zone_bounds -- depth 6 > 4
app/services/insights_llm.py:2192: _assemble_user_prompt -- depth 5 > 4
-> exit 1

app/services/tactic_detector.py:
OK: 47 functions scanned, no breaches
-> exit 0
```

Note: `fetch_flaw_comparison` (243 logic LOC) is the literal-heavy `select()` function 214-RESEARCH.md flagged as NOT breaching ruff's `PLR0915` (statement count) — exactly the "long in lines, not long in logic" signal the plan's design anticipated. Its own plan should evaluate whether to apply the `# check-function-size: allow-loc` pragma or split it.

## Self-Check: PASSED

- `scripts/check_function_size.py` — FOUND on disk
- `tests/scripts/test_check_function_size.py` — FOUND on disk
- Commits `28ab52533`, `2fa1cbdea`, `0970bca1b`, `d89df6f22`, `ec4e88dc2`, `d17ba841f` — all FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>`: `uv run ruff check .` (pass), `uv run pytest -n auto tests/scripts/test_check_function_size.py -q` (18 passed), `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` (runs, exit 1, per-function report), `uv run complexipy --version` (7.0.1, no `--with`), `uv run ty check app/ tests/ scripts/` (zero errors), `uv run ruff format --check app/ tests/ scripts/` (clean), `uv run pytest -n auto -x` (4496 passed, 0 failed)

---
*Phase: 214-backend-god-file-decomposition*
*Completed: 2026-09-02*
