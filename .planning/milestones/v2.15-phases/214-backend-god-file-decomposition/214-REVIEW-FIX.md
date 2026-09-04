---
phase: 214-backend-god-file-decomposition
fixed_at: 2026-09-03T16:21:53Z
review_path: .planning/phases/214-backend-god-file-decomposition/214-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 1
status: all_fixed
---

# Phase 214: Code Review Fix Report

**Fixed at:** 2026-09-03T16:21:53Z
**Source review:** .planning/phases/214-backend-god-file-decomposition/214-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope (critical + warning): 3
- Fixed: 3
- Skipped: 1 (IN-01, out of scope for `fix_scope: critical_warning`)

All work was done in an isolated git worktree (`gsd-reviewfix/214-<pid>`) and fast-forwarded
onto `gsd/phase-214-backend-god-file-decomposition` after each commit landed. Verification
(`ruff format`/`ruff check`/`ty check`/`pytest`) ran inside that worktree, which is a full
checkout of the same branch tip — the results are reproducible from the branch as it now
stands.

## Fixed Issues

### CR-01: check_function_size.py undercounts nesting depth for a depth-incrementing statement nested directly inside a `try` body/handler

**Files modified:** `scripts/check_function_size.py`, `tests/scripts/test_check_function_size.py`
**Commit:** `606cb3b17`
**Applied fix:** Introduced a `_stmt_depth(node, depth)` dispatcher that applies the same
depth-incrementing rule to a statement regardless of whether it's reached via `_walk_depth`'s
child loop or `_depth_of_try`'s block iteration. `_depth_of_try` now routes every `try`-body /
`orelse` / `finalbody` statement and every handler through `_stmt_depth` instead of calling
`_walk_depth` directly with a hardcoded `depth + 1`; `_walk_depth`'s child loop was simplified
to route through the same dispatcher, so the two entry points cannot drift apart again. Added
`test_if_nested_directly_inside_try_body_counts_its_own_increment` (the "try wraps if" mirror
of the existing "if wraps try" test) reproducing the review's minimal repro — asserts
`max_nesting_depth == 5` for a `try` wrapping four nested `if`s, matching the corrected walker.

Verification: `uv run pytest tests/scripts/test_check_function_size.py -q` — 19/19 passed after
this commit (20/20 after CR-02 landed). `ruff format`/`ruff check --fix`/`ty check` on the
modified files: clean. Re-ran the corrected gate against all six phase-214 files
(`uv run python scripts/check_function_size.py <6 files> --fail-over-depth 4 --fail-over-loc
200`): `OK: 283 functions scanned, no breaches` — no function newly breaches the hard depth
limit under the corrected measurement.

### CR-02: check_function_size.py's logic-LOC counter includes multi-line function-signature continuation lines as logic lines

**Files modified:** `scripts/check_function_size.py`, `tests/scripts/test_check_function_size.py`
**Commit:** `c7aa8a3af`
**Applied fix:** `logic_loc` now derives the body's true start line from `body[0].lineno`
(the first real body statement) instead of `def_line + 1`, which incorrectly assumed the body
begins immediately after the `def` line — wrong for any multi-line signature (kwonly args,
multi-line return-type annotation, etc.). Added
`test_multiline_signature_continuation_lines_are_not_counted_as_logic`, reproducing the
review's repro (an `async def foo(...)` with a 5-line kwonly signature) and asserting
`logic_loc == 2` (only `x = 1` and `return x`), matching the hand-corrected count.

Verification: same pytest/ruff/ty run as CR-01 (both fixes are in the same test file/module) —
20/20 tests passed, lint/type-check clean. Re-ran the corrected gate against all six phase-214
files after both CR-01 and CR-02 landed: `OK: 283 functions scanned, no breaches`. Per the
task's instruction, since no function newly breaches the hard limits under the corrected
(more accurate) measurement, no app-code refactor was needed or performed.

### WR-01: `_write_oracle_counts` carries a redundant `game_id` parameter that duplicates `game.id`

**Files modified:** `app/services/eval_apply.py`
**Commit:** `7a08130dc`
**Applied fix:** Dropped the `game_id: int` parameter from `_write_oracle_counts` (it always
equaled `game.id` at the one call site, which loads `game` via `select(Game).where(Game.id ==
game_id)`); the `UPDATE games ... WHERE id == game_id` clause now reads `game.id` directly.
Updated the docstring to explain the invariant and updated the single call site in
`_classify_and_fill_oracle` to drop the now-redundant argument. Confirmed via grep that
`_write_oracle_counts` has exactly one call site and no test module references the private
helper directly.

Verification: `uv run ruff format`/`ruff check --fix`/`ty check` on `app/services/eval_apply.py`
— clean (a full `ty check app/ tests/ scripts/` run surfaced 3 pre-existing `unresolved-import`
errors for `numpy`/`onnxruntime` in unrelated `scripts/` files — a known artifact of this being
a fresh worktree without the `maia-inference` optional dependency group installed; none
reference the modified file). `uv run pytest tests/services/test_eval_apply.py -q` — 29/29
passed. For extra confidence given this is a hot write path, also ran
`tests/services/test_eval_drain.py`, `tests/services/test_full_eval_drain.py`, and
`tests/services/test_eval_drain_stage_b.py` — 90 passed, 4 skipped (pre-existing skips,
unrelated to this change).

## Skipped Issues

### IN-01: `_pragma_for_def`'s "line immediately above `def`" check does not account for decorators

**File:** `scripts/check_function_size.py:192-201`
**Reason:** Out of scope — `fix_scope` for this run is `critical_warning`, and IN-01 is an
Info-severity finding. Left unfixed per explicit instruction; documented here for visibility
only. Not currently triggered anywhere in the codebase per the review (the one real
`allow-loc` pragma usage is on an undecorated function).
**Original issue:** `node.lineno` for a `FunctionDef`/`AsyncFunctionDef` points at the `def`
keyword line, not at any decorator above it. `_pragma_for_def` only checks the single line
immediately above `def`, so a pragma placed above a decorator (two lines above `def`) would
not be found, silently failing to grant the LOC exemption.

---

_Fixed: 2026-09-03T16:21:53Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
