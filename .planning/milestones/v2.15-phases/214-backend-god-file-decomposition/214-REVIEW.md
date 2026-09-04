---
phase: 214-backend-god-file-decomposition
reviewed: 2026-09-03T05:00:10Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - app/repositories/library_repository.py
  - app/repositories/train_repository.py
  - app/services/endgame_service.py
  - app/services/eval_apply.py
  - app/services/insights_llm.py
  - app/services/tactic_detector.py
  - CLAUDE.md
  - docs/dev-tooling.md
  - pyproject.toml
  - scripts/check_function_size.py
  - tests/scripts/test_check_function_size.py
  - tests/services/golden/insights_user_prompt.txt
  - tests/services/test_insights_llm.py
findings:
  critical: 2
  warning: 1
  info: 1
  total: 4
status: issues_found
---

# Phase 214: Code Review Report

**Reviewed:** 2026-09-03T05:00:10Z
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

This phase decomposes six large backend files into named stage helpers without changing
behavior, plus ships a new stdlib-AST function-size gate (`scripts/check_function_size.py`).

I traced the full `git diff 6bee7ca0c..HEAD` for each of the six app files against the
pre-refactor code, function by function, checking DB-write ordering, early-return/continue
semantics, Sentry capture placement, iteration order, and default values. The decomposition
itself is careful and, as far as I can verify by direct diff comparison plus the full local
test run (`ruff check .`, `ty check app/ tests/ scripts/`, and the targeted pytest suites for
all six files — 205+136 tests, all green), behavior-preserving. `insights_llm.py` in
particular ships a byte-level golden-file oracle (`tests/services/golden/insights_user_prompt.txt`)
that closes the gap plain substring assertions would have missed (reordered sections, filter
stage moved one call-site too early/late) — a genuinely strong verification artifact for this
kind of refactor.

The problems are concentrated entirely in the **new** `scripts/check_function_size.py` tool
itself, not in the six decomposed app files. I found and empirically verified two independent
AST-measurement bugs — one systemic overcount (multi-line function signatures), one
undercount (a depth-incrementing statement directly inside a `try` body) — both provable by
running the script against real functions in this repo and comparing to hand-corrected logic.
Neither is caught by the new test suite because its fixtures never combine those two shapes.
Since this script is presented in CLAUDE.md/docs/dev-tooling.md as the authoritative backend
nesting-depth/logic-LOC measurement tool going forward, these are load-bearing correctness
bugs in the tool itself, even though they happen not to flip any pass/fail verdict for the six
files in *this* phase's current state.

## Critical Issues

### CR-01: check_function_size.py undercounts nesting depth for a depth-incrementing statement nested directly inside a `try` body/handler

**File:** `scripts/check_function_size.py:103-136`
**Issue:**

`_depth_of_try` iterates each of `node.body` / `node.handlers` / `node.orelse` /
`node.finalbody` and calls `_walk_depth(stmt, depth + 1)` directly on each top-level
statement. But `_walk_depth(node, depth)` only ever applies the "is this a depth-incrementing
type" check to the **children** of `node` — never to `node` itself. So when `stmt` passed in
by `_depth_of_try` is itself an `If`/`For`/`While`/`With`/`Match` (i.e. a depth-incrementing
construct sitting directly in the try body), that statement's own increment is silently lost:
its nested block is measured at the *same* depth as the try body, not one level deeper.

This is asymmetric and wrong relative to the mirror case (`if` wrapping `try`), which is
correctly measured because the `If` is reached via the normal `isinstance(child,
_DEPTH_INCREMENTING_TYPES)` branch in `_walk_depth`'s child loop.

Verified with a minimal repro:

```python
def f(flag):
    try:
        if flag:
            if flag:
                if flag:
                    if flag:
                        risky()
    except ValueError:
        pass
```

This reports `max_nesting_depth == 4` (script's output), but the true nesting depth is 5
(try=1, then four nested ifs=2,3,4,5). At `--fail-over-depth 4` (CLAUDE.md's hard limit) this
function should FAIL the gate and does not — a false negative in a hard-limit quality gate.

I additionally diffed the reported depth against a corrected walker across all functions in
the six phase-214 files and found real (non-synthetic) undercounts already present in shipped
code — harmless today only because the corrected depth still happens to sit at ≤4, i.e. the
gate got lucky, not because the algorithm is right:

- `app/repositories/library_repository.py:2433` `fetch_tactic_lines` — reported depth 2, true depth 3
- `app/repositories/train_repository.py:1933` `_materialize_session_rows` — reported depth 3, true depth 4 (now sitting exactly at the hard limit; one more nesting level added here in the future would silently pass)
- `app/services/eval_apply.py:1526` `_walk_pv_boards` — reported depth 2, true depth 3
- `app/services/eval_apply.py:2181` `_build_best_move_candidates` — reported depth 1, true depth 2

**Fix:** route every statement `_depth_of_try` iterates through the same dispatch logic
`_walk_depth`'s child loop already applies to children, rather than force-adding `depth + 1`
and calling `_walk_depth` directly:

```python
def _stmt_depth(node: ast.AST, depth: int) -> int:
    """Depth contribution of `node` sitting at `depth`, applying the same
    depth-incrementing rule `_walk_depth` applies when it visits a child."""
    if isinstance(node, ast.Try):
        return _depth_of_try(node, depth)
    if isinstance(node, _DEPTH_INCREMENTING_TYPES):
        return _walk_depth(node, depth + 1)
    return _walk_depth(node, depth)


def _depth_of_try(node: ast.Try, depth: int) -> int:
    best = depth
    for stmt in (*node.body, *node.orelse, *node.finalbody):
        best = max(best, _stmt_depth(stmt, depth + 1))
    for handler in node.handlers:
        best = max(best, _stmt_depth(handler, depth + 1))
    return best
```

and have `_walk_depth`'s main child loop call the same `_stmt_depth` helper for its
`ast.Try` / `_DEPTH_INCREMENTING_TYPES` branches, so both entry points can't drift apart
again. Add a regression test with the "try wraps if" shape (the existing suite only tests
"if wraps try" — `test_nested_try_except_inside_if_reports_depth_two`).

### CR-02: check_function_size.py's logic-LOC counter includes multi-line function-signature continuation lines as logic lines

**File:** `scripts/check_function_size.py:164-189`
**Issue:**

`logic_loc` computes `start = def_line + 1` and then counts every non-blank, non-comment,
non-docstring line from `start` through `end` (the function's `end_lineno`). This assumes the
function body begins on the line immediately after `def ...:`. For any function with a
multi-line signature — extremely common in this exact phase, since most of the newly
extracted helpers use keyword-only args spread across several lines — the parameter
continuation lines fall between `def_line + 1` and the real first body statement, and get
miscounted as "logic" lines.

The tool's own docstring states the opposite intent: *"The `def`/signature line itself is
excluded — only lines within the function's body are counted"* (line 168-171) — but only the
single `def` line is excluded, not the rest of a multi-line signature.

Verified via minimal repro:

```python
async def foo(
    a: int,
    b: int,
    *,
    c: str,
) -> int:
    """doc."""
    x = 1
    return x
```

`ast.parse` gives `fn.lineno == 2` (the `async def foo(` line) and `fn.body[0].lineno == 8`
(the docstring). The script counts lines 3-7 (`a: int,`, `b: int,`, `*,`, `c: str,`, `) ->
int:`) as logic lines even though none of them are in the body — `logic_loc` returns 7
instead of the correct 2.

I ran a corrected implementation (using `node.body[0].lineno` as the true body start instead
of `def_line + 1`) against every function in all six phase-214 files: **201 of 283 functions
(71%) report a different (always higher, i.e. overcounted) `logic_loc` under the current
buggy implementation**, e.g. `library_repository.py:_flaw_position_lateral` reports 13,
true 11; `train_repository.py:get_progress` reports 67, true 65. This is not an edge case —
it is the common case for this codebase's style, and it directly undermines the stated
purpose of the tool (accurately measuring logic LOC where ruff's stable rules can't).

**Fix:** derive the body start from the first real body statement instead of `def_line + 1`:

```python
def logic_loc(node: ast.AST, lines: list[str]) -> int:
    body = getattr(node, "body", None)
    end = getattr(node, "end_lineno", None)
    if not body or end is None:
        return 0
    start = body[0].lineno  # first body stmt -- correctly skips a multi-line signature
    docstring_range = _docstring_line_range(node)
    ...  # unchanged from here
```

Add a regression test with a multi-line (kwonly-arg) signature — the existing suite's
`test_logic_loc_excludes_blank_comment_and_docstring_lines` and
`test_raw_loc_is_reported_separately_from_logic_loc` fixtures both use single-line `def f(x):`
signatures, so neither exercises this path.

## Warnings

### WR-01: `_write_oracle_counts` carries a redundant `game_id` parameter that duplicates `game.id`

**File:** `app/services/eval_apply.py:1139, 1311-1312`
**Issue:** `_write_oracle_counts(session, game, game_id, positions)` takes both a `Game` object
and a separate `game_id: int`, even though `game_id` is always `game.id` — the caller in
`_classify_and_fill_oracle` loads `game` via `select(Game).where(Game.id == game_id)`, so the
two can never legitimately diverge, but nothing enforces that invariant at the type level. The
function body uses `game_id` (not `game.id`) in its `UPDATE games ... WHERE id == game_id`
clause. Two parameters carrying the same value invites a future edit (e.g. someone reloading
`game` mid-refactor for a different id) to silently desync them.
**Fix:** drop the `game_id` parameter and use `game.id` directly in the `WHERE` clause:

```python
async def _write_oracle_counts(
    session: AsyncSession, game: Game, positions: list[GamePosition]
) -> bool:
    ...
    .where(games_table.c.id == game.id)
```

Update the one call site in `_classify_and_fill_oracle` to drop the now-redundant `game_id`
argument.

## Info

### IN-01: `_pragma_for_def`'s "line immediately above `def`" check does not account for decorators

**File:** `scripts/check_function_size.py:192-201`
**Issue:** `node.lineno` for a `FunctionDef`/`AsyncFunctionDef` points at the `def` keyword
line, not at any decorator above it (Python 3.8+ AST semantics). `_pragma_for_def` checks only
`lines[def_lineno - 2]` — the single line immediately above `def`. For a decorated function,
e.g.:

```python
# check-function-size: allow-loc reason
@some_decorator
def f(x):
    ...
```

the pragma line is two lines above `def`, not one, so `_pragma_for_def` would fail to find it
and the LOC exemption silently would not apply. Not currently triggered anywhere in the
codebase (the one real usage in `library_repository.py:2007` is on an undecorated function),
but it's a latent gap the docstring's usage instructions don't call out.
**Fix:** either document that the pragma must sit directly above the `def` keyword (below any
decorators), or walk upward past consecutive `@...` decorator lines before checking for the
pragma.

---

_Reviewed: 2026-09-03T05:00:10Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
