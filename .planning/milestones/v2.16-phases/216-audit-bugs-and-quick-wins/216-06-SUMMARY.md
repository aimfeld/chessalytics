---
phase: 216-audit-bugs-and-quick-wins
plan: 06
subsystem: backend
tags: [refactor, complexity-gate, ci, nesting-depth, ast]

# Dependency graph
requires:
  - phase: 216-02
    provides: "the .github/workflows/ci.yml test job with its Caddyfile validate step, unmodified structurally by this plan (new step inserted before it)"
  - phase: 216-04
    provides: "the .github/workflows/ci.yml test job's cached astral-sh/setup-uv@v10 and npm caching, unmodified by this plan"
provides:
  - "all eight D-13 nesting-depth breaches in app/ fixed via zero-behavior-change extraction (no baseline file, no depth pragma)"
  - "scripts/check_function_size.py gated as a CI step (Function-size gate, test job) and as a line in CLAUDE.md's mandatory pre-merge gate block"
  - "docs/dev-tooling.md's check_function_size.py bullet records the new CI/pre-merge enforcement"
affects: [216-audit-bugs-and-quick-wins]

# Actuals (#2632)
actuals:
  tokens: 12000
  tasks: 5
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AST nesting-depth mental model: an elif clause is itself a nested ast.If inside the parent If's orelse, so each additional elif in a chain adds one depth level beyond what a human reader perceives as a flat ladder — collapsing a since-override/tz-aware elif-branch chain into a single extracted function (not just flattening the if/else) was necessary to clear the gate (import_service.py)."
    - "Combining two nested async-with statements into one (async with a, b:) is a single ast.AsyncWith node with two withitems, not two nested nodes — costs 1 depth level instead of 2, with identical context-manager enter/exit ordering (lichess_client.py)."
    - "itertools.product(outer_seq, inner_dict.items()) flattens a double for-loop into a single ast.For for gate purposes while preserving the exact same (outer, inner) iteration order (user_benchmark_percentiles_service.py compute_stage_b)."
    - "A shared per-cell/per-item helper parameterized on a stage/mode label (e.g. stage_label: Literal['A', 'B']) keeps Sentry set_context attribution correct across call sites that used to have separate inline try/except blocks."

key-files:
  modified:
    - app/services/lichess_client.py
    - app/services/user_benchmark_percentiles_service.py
    - app/routers/position_bookmarks.py
    - app/services/openings_service.py
    - app/services/chesscom_client.py
    - app/services/import_service.py
    - app/services/library_service.py
    - .github/workflows/ci.yml
    - CLAUDE.md
    - docs/dev-tooling.md

key-decisions:
  - "lichess_client.py needed a THIRD helper (_stream_one_attempt) beyond the plan's two named seams (_raise_for_status, _normalize_line). Two helpers alone still left the outer retry loop's yield+on_game_fetched-callback chain at depth 5 (for/try/with/asyncfor/if = 4 ancestor levels, any if inside the asyncfor body lands at depth 5). Extracting the whole per-attempt semaphore+stream+line-loop into a separate async generator resets the depth count to 0 for that scope, dropping the outer function to depth 3 and the new helper to depth 3. This is the plan's own escape valve ('take the second seam further rather than adding a pragma') exercised as designed."
  - "user_benchmark_percentiles_service.py: compute_stage_b's family x tc double loop is flattened via itertools.product(STAGE_B_METRIC_FAMILIES, anchors.items()) rather than extracting the whole inner loop as a second helper — one ast.For instead of two, same iteration order (family-major, tc-minor), no second helper needed."
  - "position_bookmarks.py: _build_position_suggestion stays in the router module rather than moving to a new service file. position_bookmarks has no existing service layer (only position_bookmark_repository), and creating one is a layering refactor this phase explicitly excludes ('a depth fix, not a layering refactor')."
  - "chesscom_client.py: only fetch_chesscom_games_backward was refactored. The sibling forward-walk function (fetch_chesscom_games) has an almost-identical per-game normalize+yield block but sits exactly at depth 4 (not breaching) — left untouched per the scope boundary rule (don't refactor code the current task didn't break)."

requirements-completed: []

coverage:
  - id: D1
    description: "All eight D-13 nesting-depth breaches (fetch_lichess_games depth 7, compute_stage_a depth 6, compute_stage_b depth 7, get_suggestions/fetch_chesscom_games_backward/_make_game_iterator/_build_card/get_time_series depth 5) fixed via zero-behavior-change extraction, no baseline file, no depth pragma"
    requirement: null
    verification:
      - kind: unit
        ref: "uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200"
        status: pass
      - kind: unit
        ref: "tests/test_lichess_client.py, tests/test_import_service.py, tests/services/test_user_benchmark_percentiles_service.py, tests/services/test_user_benchmark_percentiles_service_real_data.py, tests/services/test_import_service_stage_a.py, tests/services/test_eval_drain_stage_b.py, tests/services/test_percentile_compute_gate.py, tests/test_bookmarks_router.py, tests/test_openings_time_series.py, tests/test_aggregation_sanity.py, tests/test_chesscom_client.py, tests/services/test_import_service.py, tests/services/test_library_service.py, tests/routers/test_imports_readiness.py (all unmodified)"
        status: pass
    human_judgment: false
  - id: D2
    description: "No existing test file rewritten; tests may only be added"
    verification:
      - kind: other
        ref: "git diff --numstat -- tests/ (0 deleted lines across all task diffs)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The gate runs as a CI step (Function-size gate, immediately after Type check (ty, analysis project)) and as a line in CLAUDE.md's mandatory pre-merge gate block, scoped to app/ only"
    verification:
      - kind: other
        ref: "uv run python -c \"import yaml; ...\" step-position/command assertion"
        status: pass
      - kind: other
        ref: "sed -n '/^### Pre-merge gate/,/^```$/p' CLAUDE.md | grep -c 'check_function_size.py app/ ...' (== 1)"
        status: pass
      - kind: other
        ref: "docs/dev-tooling.md bullet extended with one sentence, no second bullet added"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full pre-merge gate (backend + frontend) is green over the whole refactor"
    verification:
      - kind: integration
        ref: "uv run ruff format --check / ruff check . / ty check app+tests+scripts / ty check analysis/"
        status: pass
      - kind: integration
        ref: "uv run pytest -n auto -x (4506 passed, 19 skipped)"
        status: pass
      - kind: integration
        ref: "cd frontend && npm run lint && npm test -- --run (251/251 files, 3894/3894 tests)"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-09-04
status: complete
---

# Phase 216 Plan 06: Function-Size Gate — All Eight D-13 Breaches Fixed and Gated Summary

**Extracted zero-behavior-change helper functions to clear all eight CLAUDE.md nesting-depth breaches, then added `scripts/check_function_size.py` as a CI step and a `CLAUDE.md` pre-merge gate line so a regression fails closed.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-09-04 (baseline gate run confirming D-13's eight breaches)
- **Completed:** 2026-09-04T19:33:44+02:00
- **Tasks:** 5 of 5 completed
- **Files modified:** 10 (7 source files, `.github/workflows/ci.yml`, `CLAUDE.md`, `docs/dev-tooling.md`)

## Baseline gate output (recorded before any fix, matches D-13 exactly)

```
app/routers/position_bookmarks.py:39: get_suggestions -- depth 5 > 4
app/services/chesscom_client.py:375: fetch_chesscom_games_backward -- depth 5 > 4
app/services/import_service.py:1010: _make_game_iterator -- depth 5 > 4
app/services/library_service.py:478: _build_card -- depth 5 > 4
app/services/lichess_client.py:51: fetch_lichess_games -- depth 7 > 4
app/services/openings_service.py:282: get_time_series -- depth 5 > 4
app/services/user_benchmark_percentiles_service.py:428: compute_stage_a -- depth 6 > 4
app/services/user_benchmark_percentiles_service.py:505: compute_stage_b -- depth 7 > 4
```

## Closing gate output (after Task 4, confirmed again after Task 5's formatting fix)

```
OK: 1028 functions scanned, no breaches
```

## Accomplishments

- **Task 1 — `lichess_client.py::fetch_lichess_games`, depth 7 → 3.** Extracted `_raise_for_status` (the HTTP status-code branch chain: 404/429/5xx/other-non-200) and `_normalize_line` (the per-NDJSON-line JSON-parse + normalize, swallowing exactly `json.JSONDecodeError` and `Exception`). Two helpers alone still left the outer retry loop's `yield` + `on_game_fetched()` callback chain at depth 5 (for/try/with/asyncfor/if = 4 ancestor levels puts any `if` inside the async-for body at depth 5), so a third helper `_stream_one_attempt` (an async generator combining the semaphore+stream context managers into one `async with a, b:` and doing the per-line loop) takes the whole per-attempt streaming logic out of the retry loop, exercising the plan's own escape valve ("take the second seam further rather than adding a pragma"). Zero behavior change: identical exception types/ordering, retry/backoff semantics, and Sentry captures; generator-suspension semantics keep `on_game_fetched()` firing at the same logical point relative to each yielded game.
- **Task 2 — `user_benchmark_percentiles_service.py::compute_stage_a`/`compute_stage_b`, depth 6/7 → 4.** Extracted the shared per-(metric, tc) cell body (compute → interpolate → upsert, re-raise `asyncio.CancelledError`, capture-and-continue on any other exception) into `_compute_and_upsert_cell(..., stage_label=...)`, called from both stages. `stage_label` (`Literal["A", "B"]`) keeps a cell failure attributable to its originating stage in Sentry, matching the two separate inline `set_context` calls it replaces. `compute_stage_b`'s `family × tc` double loop additionally needed flattening (the helper alone still left the double loop one level past the gate, 7 → 5): iterating `itertools.product(STAGE_B_METRIC_FAMILIES, anchors.items())` collapses it to one `for` loop in the same family-major/tc-minor order. `compute_stage_a`'s single loop only needed the helper extraction (6 → 4).
- **Task 3 — `position_bookmarks.py::get_suggestions` and `openings_service.py::get_time_series`, both depth 5 → ≤3.** Extracted the per-position loop body (including the FEN-reconstruction try/except) into `_build_position_suggestion`, kept in the router module since `position_bookmarks` has no service layer to move it to (documented decision, not a layering refactor). Extracted the per-bookmark rolling-window computation (nested per-game loop, window check, outcome branch chain) into `_build_bookmark_time_series` in `openings_service.py`, called once per bookmark. Hit one incidental `ty` error along the way: `_build_position_suggestion`'s `color` parameter needed the `Color = Literal["white", "black"]` type alias (not bare `str`) since extracting it from the enclosing `for color in ("white", "black")` loop lost ty's inline literal narrowing — fixed by importing `Color` from `app.schemas.position_bookmarks`.
- **Task 4 — the three import/library breaches, all depth 5 → ≤4, gate reaches zero breaches project-wide.** `chesscom_client.py::fetch_chesscom_games_backward`: extracted `_yield_games_from_archive` (per-month normalize+yield loop), mirroring Task 1's per-line pattern; the sibling forward-walk function has a near-identical block but sits exactly at depth 4 (not breaching) and was deliberately left untouched (scope boundary). `import_service.py::_make_game_iterator`: extracted the lichess since-override/previous-last-synced/tz-aware chain into `_resolve_lichess_since_ms` — this chain sat inside an `elif` branch, and an AST insight worth recording: each additional `elif` in a chain is itself a nested `ast.If` inside the parent's `orelse`, adding a depth level beyond what a flat if/elif/elif reads as to a human, which is why the four-level literal chain reached depth 5 even though it "looked like" three levels. `library_service.py::_build_card`: extracted the per-row tactic-slot computation (decided-lost lookup, both `tactic_slot_visible` gates, motif/confidence/depth resolution) into `_build_tactic_by_ply_entry`, returning `(ply, entry) | None`.
- **Task 5 — gated in both places.** Added a `Function-size gate` step to `.github/workflows/ci.yml`'s test job, immediately after `Type check (ty, analysis project)` and before `Caddyfile validate`, running the exact D-14 command. Added the identical command as a new line in `CLAUDE.md`'s pre-merge gate bash fence, next to the `ty` lines. Extended the existing `docs/dev-tooling.md` `scripts/check_function_size.py` bullet with one sentence (no second bullet). Ran the complete pre-merge gate over the whole refactor: `ruff format --check`, `ruff check .`, `ty check app/ tests/ scripts/`, `ty check analysis/` (all clean after one ruff-format fix — see Deviations), full backend suite (4506 passed, 19 skipped), frontend lint clean, frontend tests 3894/3894 passed.

## Task Commits

Each task was committed atomically:

1. **Task 1: Flatten fetch_lichess_games (depth 7, the worst) and prove the whole loop** - `4880662ee` (refactor)
2. **Task 2: compute_stage_a and compute_stage_b — one shared seam, two call sites** - `760eb2e99` (refactor)
3. **Task 3: get_suggestions and get_time_series — extract the per-item loop body** - `bc01cdc6c` (refactor)
4. **Task 4: The three import and library breaches** - `d6c22b603` (refactor)
5. **Task 5: Gate it in CI and in the pre-merge block, then run the full gate** - `7fce8beca` (feat, includes a bundled `style` fix — see Deviations)

**Plan metadata:** pending (this commit, `docs(216-06): complete plan`)

## Files Created/Modified

- `app/services/lichess_client.py` — `_raise_for_status`, `_normalize_line`, `_stream_one_attempt` helpers; `fetch_lichess_games` retry loop simplified to consume the new generator (Task 1)
- `app/services/user_benchmark_percentiles_service.py` — `_compute_and_upsert_cell` shared helper; `compute_stage_b`'s double loop flattened via `itertools.product` (Task 2)
- `app/routers/position_bookmarks.py` — `_build_position_suggestion` helper (Task 3)
- `app/services/openings_service.py` — `_build_bookmark_time_series` helper (Task 3)
- `app/services/chesscom_client.py` — `_yield_games_from_archive` helper (Task 4)
- `app/services/import_service.py` — `_resolve_lichess_since_ms` helper (Task 4)
- `app/services/library_service.py` — `_build_tactic_by_ply_entry` helper (Task 4)
- `.github/workflows/ci.yml` — new `Function-size gate` step (Task 5)
- `CLAUDE.md` — new pre-merge gate line (Task 5)
- `docs/dev-tooling.md` — extended bullet (Task 5)

## Decisions Made

See `key-decisions` in frontmatter: (1) `lichess_client.py` needed a third helper (`_stream_one_attempt`) beyond the plan's two named seams, exercising the plan's own escape valve; (2) `compute_stage_b`'s double loop flattened via `itertools.product` rather than a second extracted helper; (3) `_build_position_suggestion` stays in the router module (no existing service layer for position bookmarks, and creating one is out of this phase's scope); (4) `fetch_chesscom_games` (the forward-walk sibling of the backward-walk function fixed here) was deliberately left untouched since it already sits at exactly depth 4.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] `lichess_client.py` needed a third helper to clear the depth-4 gate**
- **Found during:** Task 1
- **Issue:** The plan named exactly two helpers (`_raise_for_status`, `_normalize_line`). After extracting both, the outer retry loop's `async for line in ...: ... if normalized is not None: yield normalized; if on_game_fetched is not None: on_game_fetched()` chain still sat at depth 5 (for/try/with/asyncfor/if = 4 ancestor levels; any `if` inside that async-for body lands one level deeper).
- **Fix:** Added a third module-scope async generator, `_stream_one_attempt`, taking the whole per-attempt semaphore+stream+per-line loop out of `fetch_lichess_games` entirely (also combining the two nested `async with` statements into one `async with a, b:` — a single AST node, costing 1 depth level instead of 2). This is explicitly permitted by the plan's own text: "If depth is still above 4, take the second seam further rather than adding a pragma."
- **Files modified:** `app/services/lichess_client.py`
- **Verification:** Gate exits 0 for this file (both immediately after Task 1 and in the final zero-breach scan); `tests/test_lichess_client.py` + `tests/test_import_service.py` pass unmodified (119 passed); ty clean.
- **Committed in:** `4880662ee`

**2. [Rule 1 - Bug/incidental type error] `_build_position_suggestion`'s `color` parameter needed `Color`, not `str`**
- **Found during:** Task 3
- **Issue:** Extracting the per-position loop body into a standalone function lost ty's inline literal-narrowing on the `for color in ("white", "black")` loop variable, so passing `color` (typed as bare `str` in the new helper's signature) into `PositionSuggestion(color=color, ...)` failed `ty check` (`Expected Literal["white", "black"], found str`).
- **Fix:** Imported the existing `Color = Literal["white", "black"]` type alias from `app.schemas.position_bookmarks` and typed the helper's `color` parameter as `Color`.
- **Files modified:** `app/routers/position_bookmarks.py`
- **Verification:** `uv run ty check app/ tests/ scripts/` clean; `tests/test_bookmarks_router.py` re-run and passing.
- **Committed in:** `bc01cdc6c`

**3. [Rule 1 - Style, surfaced by the gate itself] ruff-format collapse in `lichess_client.py`**
- **Found during:** Task 5's full pre-merge gate run
- **Issue:** `uv run ruff format --check` flagged one line: the `RuntimeError` f-string inside `_raise_for_status` (extracted in Task 1) was split across two lines to fit under the original deeper indentation; at the helper's shallower indentation it now fits on one line, so ruff wanted to collapse it.
- **Fix:** Ran `uv run ruff format app/ tests/ scripts/ analysis/` and included the one-line diff (2 lines → 1) in the Task 5 commit, per CLAUDE.md's "A CI formatter diff is always avoidable locally" guidance.
- **Files modified:** `app/services/lichess_client.py`
- **Verification:** `ruff format --check` clean afterward; gate, tests, and ty all re-confirmed green.
- **Committed in:** `7fce8beca` (bundled into the Task 5 commit with a `style(...)` note in the message body, since it was surfaced by that task's own verification pass over the whole refactor)

---

**Total deviations:** 3 auto-fixed (2 Rule 3/blocking-issue extractions needed to actually clear the gate, 1 Rule 1 incidental type/style fix each surfaced by the task's own verification loop).
**Impact on plan:** All three were necessary for the plan's own stated success criteria (zero breaches, ty-clean, gate-clean) — no scope creep. No test file was touched; no `check-function-size` pragma was added anywhere in `app/`.

## Issues Encountered

None — no verification loop needed a second attempt beyond the fixes documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 216 is now 7 of 7 plans complete. This was the last remaining plan (216-01 through 216-05 and 216-07 were already done per STATE.md). The gate is enforced going forward in both CI and the local pre-merge workflow, so a future depth-4 regression in `app/` fails closed rather than silently accumulating. No blockers for squash-merging `gsd/phase-216-audit-bugs-and-quick-wins` to `main` — the full pre-merge gate (backend + frontend) was run and is green as of this plan's last commit.

## Self-Check: PASSED

- `app/services/lichess_client.py` exists and contains `_raise_for_status`/`_normalize_line`/`_stream_one_attempt`: FOUND
- `app/services/user_benchmark_percentiles_service.py` contains `_compute_and_upsert_cell`: FOUND
- `app/routers/position_bookmarks.py` contains `_build_position_suggestion`: FOUND
- `app/services/openings_service.py` contains `_build_bookmark_time_series`: FOUND
- `app/services/chesscom_client.py` contains `_yield_games_from_archive`: FOUND
- `app/services/import_service.py` contains `_resolve_lichess_since_ms`: FOUND
- `app/services/library_service.py` contains `_build_tactic_by_ply_entry`: FOUND
- `.github/workflows/ci.yml` contains a `Function-size gate` step immediately after `Type check (ty, analysis project)`: FOUND
- `CLAUDE.md` pre-merge gate block contains the D-14 command exactly once: FOUND
- `docs/dev-tooling.md` bullet extended, no second bullet added: FOUND
- Commits `4880662ee`, `760eb2e99`, `bc01cdc6c`, `d6c22b603`, `7fce8beca` all exist on branch: FOUND
- `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200` re-run: `OK: 1028 functions scanned, no breaches`
- `git diff --numstat -- tests/` re-run over the whole plan: zero deleted lines across all existing test files
- Full pre-merge gate re-confirmed: ruff format/check clean, ty (app+tests+scripts and analysis) clean, backend suite 4506 passed/19 skipped, frontend lint clean, frontend tests 3894/3894 passed

---
*Phase: 216-audit-bugs-and-quick-wins*
*Completed: 2026-09-04*
