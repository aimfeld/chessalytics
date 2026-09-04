"""Tests for scripts.check_function_size (Phase 214, tooling for backend god-file split).

Pure AST-walk coverage — builds small source strings and asserts on the analyzer's
`FunctionRecord` output rather than on stdout formatting, so assertions survive a
cosmetic output change. Covers every bullet in 214-01-PLAN.md's `<behavior>` block:
nesting depth, try/except levels, nested-def isolation, comprehension handling,
logic-LOC exclusions (blank/comment/docstring), the `allow-loc` pragma exemption,
the CLI exit code, and directory walking.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from scripts.check_function_size import (
    FunctionRecord,
    iter_python_files,
    logic_loc,
    max_nesting_depth,
    scan_file,
    scan_source,
)

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPT_PATH = _REPO_ROOT / "scripts" / "check_function_size.py"


def _only_record(source: str) -> FunctionRecord:
    """Scan `source` and return its single top-level function's record."""
    records = scan_source(source, "memory.py")
    assert len(records) == 1, f"expected exactly one function, got {len(records)}"
    return records[0]


def _record_by_name(source: str, qualname: str) -> FunctionRecord:
    records = scan_source(source, "memory.py")
    by_name = {r.qualname: r for r in records}
    assert qualname in by_name, f"{qualname!r} not found among {list(by_name)}"
    return by_name[qualname]


# ---------------------------------------------------------------------------
# Nesting depth
# ---------------------------------------------------------------------------


def test_if_inside_for_inside_with_reports_depth_three() -> None:
    source = """
def f(items, lock):
    with lock:
        for item in items:
            if item:
                pass
"""
    record = _only_record(source)
    assert record.max_nesting_depth == 3


def test_flat_function_reports_depth_zero() -> None:
    source = """
def f(x):
    y = x + 1
    return y
"""
    record = _only_record(source)
    assert record.max_nesting_depth == 0


def test_try_and_each_except_handler_count_as_one_level() -> None:
    # try -> depth 1; the except handler body is depth 1 as well (a fresh
    # branch off the try, not nested inside it), matching how a reader
    # perceives try/except as one conceptual level, not two.
    source = """
def f():
    try:
        risky()
    except ValueError:
        handle_value_error()
    except TypeError:
        handle_type_error()
"""
    record = _only_record(source)
    assert record.max_nesting_depth == 1


def test_nested_try_except_inside_if_reports_depth_two() -> None:
    source = """
def f(flag):
    if flag:
        try:
            risky()
        except ValueError:
            pass
"""
    record = _only_record(source)
    assert record.max_nesting_depth == 2


def test_if_nested_directly_inside_try_body_counts_its_own_increment() -> None:
    # CR-01 (214-REVIEW.md): the mirror case of the test above -- a `try`
    # WRAPS a chain of `if`s instead of an `if` wrapping a `try`. Before the
    # fix, `_depth_of_try` called `_walk_depth` directly on each top-level
    # try-body statement instead of routing it through the same
    # depth-incrementing dispatch `_walk_depth`'s own child loop applies, so
    # an `If`/`For`/`While`/`With`/`Match` sitting directly in the try body
    # lost its own increment. True depth: try=1, then four nested ifs=2,3,4,5.
    source = """
def f(flag):
    try:
        if flag:
            if flag:
                if flag:
                    if flag:
                        risky()
    except ValueError:
        pass
"""
    record = _only_record(source)
    assert record.max_nesting_depth == 5


# ---------------------------------------------------------------------------
# Nested def starts a fresh depth-0 scope
# ---------------------------------------------------------------------------


def test_nested_def_does_not_inflate_outer_depth() -> None:
    source = """
def outer(items):
    if items:
        def inner(x):
            if x:
                for y in x:
                    pass
        return inner
"""
    records = {r.qualname: r for r in scan_source(source, "memory.py")}
    assert records["outer"].max_nesting_depth == 1
    assert records["outer.<locals>.inner"].max_nesting_depth == 2


# ---------------------------------------------------------------------------
# Comprehensions do not increment depth (v1 rule)
# ---------------------------------------------------------------------------


def test_comprehension_does_not_increment_depth() -> None:
    source = """
def f(items):
    if items:
        return [x for x in items if x > 0]
"""
    record = _only_record(source)
    assert record.max_nesting_depth == 1


# ---------------------------------------------------------------------------
# logic_loc exclusions: blank lines, comment-only lines, docstring lines
# ---------------------------------------------------------------------------


def test_logic_loc_excludes_blank_comment_and_docstring_lines() -> None:
    source = '''
def f(x):
    """This is a docstring.

    It spans multiple lines.
    """
    # a comment explaining the next line
    y = x + 1

    return y
'''
    record = _only_record(source)
    # Only `y = x + 1` and `return y` are logic lines.
    assert record.logic_loc == 2


def test_raw_loc_is_reported_separately_from_logic_loc() -> None:
    source = '''
def f(x):
    """Docstring."""
    # comment
    return x
'''
    record = _only_record(source)
    assert record.raw_loc == record.end_line - record.start_line + 1
    assert record.raw_loc > record.logic_loc


def test_multiline_signature_continuation_lines_are_not_counted_as_logic() -> None:
    # CR-02 (214-REVIEW.md): a multi-line (kwonly-arg) signature. Before the
    # fix, `logic_loc` used `def_line + 1` as the body start, so the
    # parameter continuation lines (`a: int,`, `b: int,`, `*,`, `c: str,`,
    # `) -> int:`) between the `async def foo(` line and the real first body
    # statement (the docstring) were miscounted as logic lines.
    source = '''
async def foo(
    a: int,
    b: int,
    *,
    c: str,
) -> int:
    """doc."""
    x = 1
    return x
'''
    record = _only_record(source)
    # Only `x = 1` and `return x` are logic lines -- the 5 signature
    # continuation lines and the docstring line are excluded.
    assert record.logic_loc == 2


# ---------------------------------------------------------------------------
# allow-loc pragma exemption
# ---------------------------------------------------------------------------


def test_pragma_exempts_loc_but_not_depth() -> None:
    source = """
# check-function-size: allow-loc large literal config table
def f(x):
    if x:
        if x:
            if x:
                if x:
                    if x:
                        pass
    return x
"""
    record = _only_record(source)
    assert record.allow_loc is True
    assert record.allow_loc_reason == "large literal config table"
    # Depth is still measured even though LOC is exempt.
    assert record.max_nesting_depth == 5


def test_function_without_pragma_is_not_exempt() -> None:
    source = """
def f(x):
    return x
"""
    record = _only_record(source)
    assert record.allow_loc is False
    assert record.allow_loc_reason is None


# ---------------------------------------------------------------------------
# Exit code: --fail-over-depth / --fail-over-loc
# ---------------------------------------------------------------------------


def _run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(_SCRIPT_PATH), *args],
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT,
        check=False,
    )


def test_cli_exits_zero_for_clean_file(tmp_path: Path) -> None:
    clean_file = tmp_path / "clean.py"
    clean_file.write_text("def f(x):\n    return x + 1\n")
    result = _run_cli(str(clean_file), "--fail-over-depth", "4", "--fail-over-loc", "200")
    assert result.returncode == 0, result.stdout + result.stderr


def test_cli_exits_one_when_depth_threshold_breached(tmp_path: Path) -> None:
    deep_file = tmp_path / "deep.py"
    deep_file.write_text(
        "def f(a):\n"
        "    if a:\n"
        "        if a:\n"
        "            if a:\n"
        "                if a:\n"
        "                    if a:\n"
        "                        pass\n"
    )
    result = _run_cli(str(deep_file), "--fail-over-depth", "4", "--fail-over-loc", "200")
    assert result.returncode == 1, result.stdout + result.stderr


def test_cli_exits_one_when_loc_threshold_breached(tmp_path: Path) -> None:
    long_file = tmp_path / "long.py"
    body_lines = "\n".join(f"    x{i} = {i}" for i in range(250))
    long_file.write_text(f"def f():\n{body_lines}\n    return x0\n")
    result = _run_cli(str(long_file), "--fail-over-depth", "4", "--fail-over-loc", "200")
    assert result.returncode == 1, result.stdout + result.stderr


def test_cli_json_output_is_parseable_and_carries_all_fields(tmp_path: Path) -> None:
    src_file = tmp_path / "sample.py"
    src_file.write_text("def f(x):\n    return x + 1\n")
    result = _run_cli(str(src_file), "--json")
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    functions = payload["functions"] if isinstance(payload, dict) else payload
    assert len(functions) == 1
    record = functions[0]
    for field in (
        "path",
        "qualname",
        "start_line",
        "end_line",
        "raw_loc",
        "logic_loc",
        "max_nesting_depth",
        "allow_loc",
        "allow_loc_reason",
    ):
        assert field in record, f"missing field {field!r} in JSON record"


# ---------------------------------------------------------------------------
# Directory walking
# ---------------------------------------------------------------------------


def test_iter_python_files_walks_directory_for_py_files(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("def f():\n    pass\n")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "b.py").write_text("def g():\n    pass\n")
    (tmp_path / "not_python.txt").write_text("ignore me\n")

    found = iter_python_files([str(tmp_path)])
    names = {p.name for p in found}
    assert names == {"a.py", "b.py"}


def test_iter_python_files_scans_single_file_argument(tmp_path: Path) -> None:
    single = tmp_path / "only.py"
    single.write_text("def f():\n    pass\n")
    found = iter_python_files([str(single)])
    assert found == [single]


def test_scan_file_reads_from_disk(tmp_path: Path) -> None:
    src_file = tmp_path / "on_disk.py"
    src_file.write_text("def f(x):\n    if x:\n        return x\n    return None\n")
    records = scan_file(src_file)
    assert len(records) == 1
    assert records[0].max_nesting_depth == 1
    assert records[0].qualname == "f"


# ---------------------------------------------------------------------------
# Direct unit coverage of the helper functions (not just via scan_source)
# ---------------------------------------------------------------------------


def test_max_nesting_depth_and_logic_loc_are_directly_importable() -> None:
    # Smoke test that the public helper names exist with the expected shape,
    # exercised indirectly above via scan_source; this just confirms the
    # module-level symbols required by the plan's acceptance criteria exist.
    assert callable(max_nesting_depth)
    assert callable(logic_loc)
