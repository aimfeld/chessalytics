"""AST nesting-depth + logic-LOC gate (Phase 214, backend god-file decomposition).

No ruff **stable** rule covers nesting depth: ruff's `PLR1702` (too-many-nested-blocks)
exists but is preview-only, and enabling `--preview` silently expands the project's
effective rule set from ~5 rules to 914 and produces thousands of new violations
project-wide (see 214-RESEARCH.md "PLR1702 was investigated and rejected"). This
stdlib-only AST walker fills that specific gap without touching ruff's config.

Logic-LOC intentionally does NOT auto-exclude large literal config objects/lookup
tables (CLAUDE.md's own carve-out for those) -- detecting "is this a literal config"
generically via AST is fragile. Instead, a function whose logic LOC is inflated purely
by a multi-line literal (e.g. a 30-column SQLAlchemy `select()`) can be marked with a
`# check-function-size: allow-loc <reason>` pragma on the line immediately above its
`def`. Ruff's `PLR0915` (statement count, immune to multi-line literals since it counts
statements not lines) is the tie-breaker signal that justifies granting the pragma: if
a function is flagged here but not by `PLR0915`, it is long in lines but not long in
logic.

Exit code: 1 if any scanned function breaches `--fail-over-depth` or `--fail-over-loc`
(the LOC threshold is skipped for a function carrying the `allow-loc` pragma; its depth
is still checked), 0 otherwise. Mirrors `ruff check`'s convention so this composes into
the same pre-merge gate chain.

Usage:
    uv run python scripts/check_function_size.py app/services/endgame_service.py
    uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200
    uv run python scripts/check_function_size.py app/ --json > report.json
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants -- no magic numbers (CLAUDE.md).
# ---------------------------------------------------------------------------

_DEFAULT_MAX_DEPTH = 4
_DEFAULT_MAX_LOGIC_LOC = 200

_PRAGMA_PREFIX = "# check-function-size: allow-loc"

# Node types that increase nesting depth by one level. `ast.Try` is handled
# separately (its body and each handler each count as one level, matching
# how a reader perceives try/except -- see `_depth_of_try`).
_DEPTH_INCREMENTING_TYPES: tuple[type[ast.AST], ...] = (
    ast.If,
    ast.For,
    ast.AsyncFor,
    ast.While,
    ast.With,
    ast.AsyncWith,
    ast.Match,
)

# A nested `def`/class starts a fresh depth-0 scope for its own record; do
# not descend into it while measuring the enclosing function's depth.
_SCOPE_BOUNDARY_TYPES: tuple[type[ast.AST], ...] = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.ClassDef,
)


@dataclass
class FunctionRecord:
    """One scanned function's size/complexity measurements."""

    path: str
    qualname: str
    start_line: int
    end_line: int
    raw_loc: int
    logic_loc: int
    max_nesting_depth: int
    allow_loc: bool
    allow_loc_reason: str | None


def iter_python_files(paths: Sequence[str]) -> list[Path]:
    """Resolve `paths` (files or directories) into a sorted list of `*.py` files.

    A directory argument is walked recursively for `*.py`; a file argument is
    included directly (even if it lacks a `.py` suffix -- the caller asked for it
    explicitly).
    """
    resolved: list[Path] = []
    for raw_path in paths:
        candidate = Path(raw_path)
        if candidate.is_dir():
            resolved.extend(sorted(candidate.rglob("*.py")))
        else:
            resolved.append(candidate)
    return resolved


def _stmt_depth(node: ast.AST, depth: int) -> int:
    """Depth contribution of `node` sitting at `depth`.

    Applies the same depth-incrementing dispatch rule `_walk_depth`'s child
    loop applies when it visits a child, so a statement that is itself a
    depth-incrementing construct (e.g. an `if` sitting directly inside a
    `try` body) gets its own increment counted regardless of which caller
    (`_walk_depth`'s child loop or `_depth_of_try`'s block iteration) is
    the one dispatching on it. Both entry points route through this single
    function so they cannot drift apart again (CR-01, 214-REVIEW.md).
    """
    if isinstance(node, ast.Try):
        return _depth_of_try(node, depth)
    if isinstance(node, _DEPTH_INCREMENTING_TYPES):
        return _walk_depth(node, depth + 1)
    return _walk_depth(node, depth)


def _depth_of_try(node: ast.Try, depth: int) -> int:
    """Return the max depth reached inside a `try` statement.

    The try body and each `except`/`else`/`finally` block each count as one
    level relative to the try statement's own depth, matching how a reader
    perceives try/except as one conceptual level (not two).
    """
    best = depth
    for stmt in (*node.body, *node.orelse, *node.finalbody):
        best = max(best, _stmt_depth(stmt, depth + 1))
    for handler in node.handlers:
        best = max(best, _stmt_depth(handler, depth + 1))
    return best


def _walk_depth(node: ast.AST, depth: int) -> int:
    best = depth
    for child in ast.iter_child_nodes(node):
        if isinstance(child, _SCOPE_BOUNDARY_TYPES):
            continue  # fresh scope, measured as its own record
        # Comprehensions do not increment depth (v1 rule) but their internals
        # (e.g. a nested call) still get scanned at the current depth --
        # `_stmt_depth` handles that (falls through to `_walk_depth(child, depth)`
        # for anything that isn't `Try`/`_DEPTH_INCREMENTING_TYPES`).
        best = max(best, _stmt_depth(child, depth))
    return best


def max_nesting_depth(node: ast.AST) -> int:
    """Return the maximum nesting depth within a function node's body.

    Does not descend into a nested `FunctionDef`/`AsyncFunctionDef`/`ClassDef`
    (each such nested scope is measured as its own, independent record).
    """
    return _walk_depth(node, 0)


def _docstring_line_range(node: ast.AST) -> tuple[int, int] | None:
    """Return the 1-indexed (start, end) line range of `node`'s docstring, if any."""
    body = getattr(node, "body", None)
    if not body:
        return None
    first = body[0]
    if (
        isinstance(first, ast.Expr)
        and isinstance(first.value, ast.Constant)
        and isinstance(first.value.value, str)
    ):
        end = first.end_lineno if first.end_lineno is not None else first.lineno
        return first.lineno, end
    return None


def logic_loc(node: ast.AST, lines: list[str]) -> int:
    """Count logic lines in `node`'s body, excluding blank/comment-only/docstring lines.

    `lines` is the full source split by line, 0-indexed; `node` must carry
    a `body` and `end_lineno`. The signature -- whether a single `def ...:`
    line or a multi-line signature spanning several lines of continuation
    (keyword-only args, return-type annotation, etc.) -- is excluded --
    only lines within the function's body are counted, per CLAUDE.md's
    logic-LOC rule ("counting logic lines... it counts the remaining body
    lines"). The body's true first line is `body[0].lineno`, NOT
    `node.lineno + 1`: for a multi-line signature those are not the same
    line, and using `node.lineno + 1` miscounts signature-continuation
    lines as logic (CR-02, 214-REVIEW.md).
    """
    body = getattr(node, "body", None)
    end = getattr(node, "end_lineno", None)
    if not body or end is None:
        return 0
    start = body[0].lineno
    docstring_range = _docstring_line_range(node)
    count = 0
    for lineno in range(start, end + 1):
        if docstring_range is not None and docstring_range[0] <= lineno <= docstring_range[1]:
            continue
        text = lines[lineno - 1].strip() if 0 < lineno <= len(lines) else ""
        if not text:
            continue
        if text.startswith("#"):
            continue
        count += 1
    return count


def _pragma_for_def(lines: list[str], def_lineno: int) -> tuple[bool, str | None]:
    """Check the source line immediately above `def_lineno` for the allow-loc pragma."""
    idx = def_lineno - 2  # 0-indexed line immediately above the 1-indexed def line
    if idx < 0 or idx >= len(lines):
        return False, None
    stripped = lines[idx].strip()
    if stripped.startswith(_PRAGMA_PREFIX):
        reason = stripped[len(_PRAGMA_PREFIX) :].strip()
        return True, reason or None
    return False, None


def _build_record(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    path: str,
    qualname: str,
    lines: list[str],
) -> FunctionRecord:
    end_line = node.end_lineno if node.end_lineno is not None else node.lineno
    allow_loc, allow_loc_reason = _pragma_for_def(lines, node.lineno)
    return FunctionRecord(
        path=path,
        qualname=qualname,
        start_line=node.lineno,
        end_line=end_line,
        raw_loc=end_line - node.lineno + 1,
        logic_loc=logic_loc(node, lines),
        max_nesting_depth=max_nesting_depth(node),
        allow_loc=allow_loc,
        allow_loc_reason=allow_loc_reason,
    )


def _visit(
    node: ast.AST,
    scope_prefix: str,
    path: str,
    lines: list[str],
    records: list[FunctionRecord],
) -> None:
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            qualname = f"{scope_prefix}{child.name}"
            records.append(_build_record(child, path, qualname, lines))
            _visit(child, f"{qualname}.<locals>.", path, lines, records)
        elif isinstance(child, ast.ClassDef):
            class_prefix = f"{scope_prefix}{child.name}."
            _visit(child, class_prefix, path, lines, records)
        else:
            _visit(child, scope_prefix, path, lines, records)


def scan_source(source: str, path: str) -> list[FunctionRecord]:
    """Parse `source` (as if it were `path`) and return one record per function."""
    tree = ast.parse(source)
    lines = source.splitlines()
    records: list[FunctionRecord] = []
    _visit(tree, "", path, lines, records)
    return records


def scan_file(path: Path) -> list[FunctionRecord]:
    """Read and scan a single Python file from disk."""
    source = path.read_text(encoding="utf-8")
    return scan_source(source, str(path))


def _breaches(record: FunctionRecord, fail_over_depth: int, fail_over_loc: int) -> list[str]:
    reasons: list[str] = []
    if record.max_nesting_depth > fail_over_depth:
        reasons.append(f"depth {record.max_nesting_depth} > {fail_over_depth}")
    if not record.allow_loc and record.logic_loc > fail_over_loc:
        reasons.append(f"logic_loc {record.logic_loc} > {fail_over_loc}")
    return reasons


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("paths", nargs="+", help="Files or directories to scan")
    parser.add_argument(
        "--fail-over-depth",
        type=int,
        default=_DEFAULT_MAX_DEPTH,
        help=f"Max nesting depth before failing (default: {_DEFAULT_MAX_DEPTH})",
    )
    parser.add_argument(
        "--fail-over-loc",
        type=int,
        default=_DEFAULT_MAX_LOGIC_LOC,
        help=f"Max logic LOC before failing (default: {_DEFAULT_MAX_LOGIC_LOC})",
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of text")
    args = parser.parse_args()

    files = iter_python_files(args.paths)
    all_records: list[FunctionRecord] = []
    for file_path in files:
        all_records.extend(scan_file(file_path))

    violations: list[tuple[FunctionRecord, list[str]]] = []
    for record in all_records:
        reasons = _breaches(record, args.fail_over_depth, args.fail_over_loc)
        if reasons:
            violations.append((record, reasons))

    if args.json:
        payload = {"functions": [asdict(r) for r in all_records]}
        print(json.dumps(payload, indent=2))
    else:
        for record, reasons in violations:
            print(f"{record.path}:{record.start_line}: {record.qualname} -- {', '.join(reasons)}")
        if not violations:
            print(f"OK: {len(all_records)} functions scanned, no breaches")

    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())
