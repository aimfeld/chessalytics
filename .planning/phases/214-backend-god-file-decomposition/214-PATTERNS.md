# Phase 214: Backend God-File Decomposition - Pattern Map

**Mapped:** 2026-09-02
**Files analyzed:** 6 god files (splits) + 1 new dev script + `pyproject.toml` config additions
**Analogs found:** 7 / 7 (this is a behavior-preserving internal refactor — every "new" file
is a sibling-module split of an existing file, so the primary analog for each split IS the
file being split; `scripts/check_function_size.py` is genuinely new and gets an external analog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|---------------|
| `scripts/check_function_size.py` (new) | utility (CLI dev tool) | batch/transform (AST walk over files) | `scripts/validate_multipv_budget.py` (argparse shape, `--check-goals`-style exit code) + `scripts/gen_flaw_thresholds_ts.py` (docstring `Usage:` block, `sys.path` bootstrap convention) | role-match (no other pure-AST-over-source-files script exists; CLI conventions transfer exactly) |
| `app/services/endgame_service.py` (split) | service | CRUD/aggregation (accumulate-then-build over already-fetched rows) | itself — extract `_normalize_endgame_row`, `_accumulate_endgame_rows`, `_build_category_stats` as siblings or in-file helpers; pattern precedent: `app/services/stats_service.py`'s `FilterParams` `TypedDict` | exact (same file; TypedDict-accumulator precedent is exact) |
| `app/services/eval_apply.py` (split) | service | request-response / transactional writes (pipeline orchestrator, one shared `AsyncSession`) | itself — 6-stage pipeline split, `_classify_and_fill_oracle` | exact |
| `app/repositories/library_repository.py` (split) | repository | CRUD/query-building | itself — extract `_build_tactic_clause` only; uses `app/repositories/query_utils.py::apply_game_filters` as the shared filter path | exact |
| `app/services/insights_llm.py` (split) | service | transform (filter-then-render prompt assembly) | itself — extract lettered `_apply_<code>_filter` stages from `_assemble_user_prompt` | exact |
| `app/services/tactic_detector.py` (split) | service | event-driven/dispatcher (tiered candidate dispatch, pure chess logic, no I/O) | itself — `_dispatch_mate_tier` / `_collect_non_mate_candidates` / `_select_shallowest_candidate` split of `detect_tactic_motif` | exact |
| `app/repositories/train_repository.py` (split) | repository | CRUD/composition | itself — split `compose_and_materialize_session`/`reveal_for_puzzle`/`load_session_puzzles`; uses `apply_game_filters` too | exact |
| `pyproject.toml` `[tool.ruff.lint]` + `[dependency-groups] dev` | config | config | itself — existing `[tool.ruff]`/`[dependency-groups]` blocks (additive, no merge conflict) | exact |

## Pattern Assignments

### `scripts/check_function_size.py` (new utility, batch/transform)

**Analogs:** `scripts/validate_multipv_budget.py` (CLI/exit-code shape), `scripts/gen_flaw_thresholds_ts.py` (docstring + import-bootstrap shape)

**Module docstring + `Usage:` block pattern** (`scripts/validate_multipv_budget.py:1-40`):
```python
"""Validate MultiPV=2 node budget: margin histogram + PV1-drift spot-check (MPV-03 / D-07).

Reads stored `game_flaws.allowed_pv_lines` JSONB blobs ...
...
SC4 exit-code gate (--check-goals): exits 1 if fewer than {_MIN_POSITIONS} positions
analyzed OR more than {_MAX_FRACTION_IN_BAND} of solver nodes fall in the margin band ...

Usage:
    uv run python scripts/validate_multipv_budget.py --db dev
    uv run python scripts/validate_multipv_budget.py --db dev --limit 5000
    uv run python scripts/validate_multipv_budget.py --db dev --check-goals
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

# Bootstrap project root so app.* imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
```
`check_function_size.py` does NOT need the `sys.path` bootstrap (per RESEARCH.md — it imports
only `ast`/`argparse`/`pathlib`/`json` from stdlib, no `app.*` import), but it MUST keep the
`Usage:` docstring block and the exit-code-gate convention (mirror `--check-goals`'s "exits 1
if..." explicit statement, but named `--fail-over-depth`/`--fail-over-loc` per the ROADMAP/
RESEARCH design).

**`sys.path` bootstrap + drift-check exit code pattern** (`scripts/gen_flaw_thresholds_ts.py:1-33`):
```python
"""Generate frontend/src/generated/flawThresholds.ts from flaws_service.py constants.
...
Usage (drift check — exits 1 if generated output differs from the committed file):
    uv run python scripts/gen_flaw_thresholds_ts.py --check
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))
```
Use this shape for the doc convention only (the "exits 1 if X" one-liner style); `check_function_size.py` has no `app.*` import so skip the `sys.path.insert`.

**Argparse + `Path` args + dataclass records pattern** (`scripts/validate_multipv_budget.py`,
observed structure — argparse with `--db`, `--limit`, `--check-goals` flags, `@dataclass` for
per-record output, exit code driven by a threshold check at the bottom of `main()`). Apply the
same shape:
```python
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="Files or directories to scan")
    parser.add_argument("--fail-over-depth", type=int, default=4)
    parser.add_argument("--fail-over-loc", type=int, default=200)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    ...
    return 1 if violations else 0

if __name__ == "__main__":
    sys.exit(main())
```

**ty compliance note:** `[tool.ty.environment] extra-paths = ["scripts"]` (pyproject.toml:83-87)
already covers `scripts/` importing `scripts/` — irrelevant here since this script has no
sibling-script imports, but confirms no extra ty config is needed. All functions need explicit
return type annotations (`-> int`, `-> list[FunctionRecord]`, etc.) per CLAUDE.md.

**Docs update target:** `docs/dev-tooling.md:14-16` lists `scripts/gen_*.py` and
`scripts/backfill_*.py` bullets with one-line non-obvious-behavior notes — add a matching
bullet for `scripts/check_function_size.py` in the same list style:
```
- **`scripts/check_function_size.py`** — AST nesting-depth + logic-LOC gate (no ruff stable
  rule covers nesting depth); `--fail-over-depth 4 --fail-over-loc 200`, `--json` for CI.
```

---

### `app/services/endgame_service.py` (service, CRUD/aggregation split)

**Analog:** itself (`_aggregate_endgame_stats`, lines 397-780) + `app/services/stats_service.py` for the TypedDict-accumulator convention

**Existing TypedDict pattern to copy for the accumulator bundle** (`app/services/stats_service.py:55-72`):
```python
class FilterParams(TypedDict):
    """Typed filter parameters for position WDL batch queries.

    Created per D-02: TypedDicts for internal data structures.
    Matches keyword parameters of query_position_wdl_batch in stats_repository.py.
    """

    time_control: list[str] | None
    platform: list[str] | None
    rated: bool | None
    opponent_type: str
    from_date: datetime.date | None
    to_date: datetime.date | None
    opponent_gap_min: int | None
    opponent_gap_max: int | None
```
Use this exact `TypedDict` shape (docstring citing the D-0x/phase decision + "matches
keyword parameters of X" cross-reference) for `_EndgameAccumulators` (the 11-field bundle:
`wdl`, `conv`, `recov`, `gaps_by_class`, `starts_by_class`, `ends_by_class`,
`gaps_by_bucket`, `eval_sum_by_class`, `eval_sumsq_by_class`, `eval_n_by_class`,
`last_played_at_by_class`).

**Core pipeline-orchestrator pattern** (`app/services/endgame_service.py:397-780`, per
RESEARCH.md's worked example): split into `_normalize_endgame_row(row) -> _EndgameRow`,
`_accumulate_endgame_rows(rows) -> _EndgameAccumulators`, `_build_category_stats(endgame_class,
accumulators) -> EndgameCategoryStats`, with `_aggregate_endgame_stats` becoming the thin
orchestrator (normalize → accumulate → build → sort → return). Reuse the same three helpers
from `_aggregate_endgame_stats_by_tc` (783-1039) rather than duplicating.

**Sentry site placement (must not move):** lines 512-517, inside the per-row loop's
`endgame_class is None` branch — must land inside `_accumulate_endgame_rows` (the function that
owns the per-row normalization/validation step) after the split.

---

### `app/services/eval_apply.py` (service, transactional pipeline split)

**Analog:** itself (`_classify_and_fill_oracle`, lines 987-1330)

**Core pipeline-orchestrator pattern** — six sequential stages, each already delimited by a
comment block in source, split into one `async` helper per stage, called sequentially from a
thin orchestrator (never `asyncio.gather` on the shared `AsyncSession` per CLAUDE.md's
critical-constraints rule):
1. Load game + ordered positions (1080-1093)
2. Classify flaws + compute `freshly_blobbed` (1095-1135)
3. Diff/upsert against `existing_plies` (1136-1211) — DELETE/INSERT/UPDATE-fresh/UPDATE-preserve-by-omission
4. Oracle count columns (1213-1265)
5. Flaw PV write, dedup by ply (1267-1317) — Sentry sites at 1312-1317 stay in this stage
6. Refresh `blobs_completed` stamp (1319-1330)

**Do NOT** bundle stages 3+4+5 behind a shared mutable context object — each stage's
inputs/outputs are narrow enough to pass as plain arguments; a context dataclass here is the
"split to fit a signature" anti-pattern the ROADMAP forbids.

**Hazard — ordering constraint:** `already_blobbed_plies` and `existing_plies` are read at
lines 1136-1163, BEFORE the DELETE at line 1172. A split must preserve this read-before-delete
ordering across function boundaries (pass the already-read values as arguments, don't re-derive
after the delete).

**Hazard — dedup pv is intentionally dropped in one function only:** `_resolve_full_eval`
(364-389) deliberately returns `pv_string=None` on a dedup hit (line 388). Do not "fix" this
during extraction — the real pv-carry path is a different, upstream function (see RESEARCH.md
Open Question 1).

**Stale comment landmine:** line 1327 still says "delete-then-insert" — it is actually a
4-way diff/upsert since Phase 150 R3. Do not let a split's new docstring repeat this comment;
verify against the actual DELETE/INSERT/UPDATE statements, not the prose.

---

### `app/repositories/library_repository.py` (repository, query-building split)

**Analog:** itself (`build_flaw_filter_clauses`, lines 527-676) + shared filter path `app/repositories/query_utils.py::apply_game_filters`

**Shared filter import pattern (must remain the sole call site)** — confirmed at
`library_repository.py:36,1154,1703,1766`:
```python
from app.repositories.query_utils import apply_game_filters, is_opponent_expr, player_only_gate
```
Do not inline a copy of this logic into any extracted helper.

**Extraction scope — narrow, not five-way:** `build_flaw_filter_clauses` is a chain of 5
independent OR-within-family clause builders (severity/tempo/opportunity/impact/phase, each
3-8 lines — too small to extract without violating "don't split to fit a signature") followed
by one larger block (lines 645-674, ~30 lines, nested loop over `_tactic_orientation_pairs`).
**Extract only** the tactic-clause block:
```python
def _build_tactic_clause(
    tactic_families: Sequence[str] | None,
    orientation: str | None,
    min_tactic_depth: int | None,
    max_tactic_depth: int | None,
    decided_lost: bool | None,
) -> ColumnElement[bool] | None:
    ...
```
Leave the other four family blocks inline.

**Thin-seam flag (mutation-test REQUIRED):** only `_TACTIC_CHIP_CONFIDENCE_MIN` is imported by
name in tests; `build_flaw_filter_clauses` itself has no directly-named test import. Prove the
`_build_tactic_clause` extraction is behavior-preserving by reverting it and confirming
`test_flaw_predicate.py`/`test_flaw_comparison.py` fail.

---

### `app/services/insights_llm.py` (service, filter-then-render split)

**Analog:** itself (`_assemble_user_prompt`, lines 2192-2385)

**Core pattern — pre-named filter stages, extract each as a same-named helper:**
```python
# Each lettered stage already has a docstring bullet naming it:
# A2 NaN/thin-drop, C2 last-3mo 90-day-overlap drop, C3 activity-gap markers,
# C4 overall-subsection-drop, C5 last-3mo-vs-all-time drop, C6 all-time point cap
def _apply_a2_filter(findings: ...) -> ...: ...
def _apply_c2_filter(findings: ...) -> ...: ...
# etc. — orchestrator calls each stage in sequence, then the render loop
```

**Hazard — private helper names pinned by test imports.** `tests/services/test_insights_llm.py`
imports `_assemble_user_prompt`, `_render_series_block`, `_format_zone_bounds`,
`_format_rating_basis_block`, `_format_time_pressure_score_gap_chart_block`, `_NO_BAND_METRICS`,
`_render_subsection_block` (aliased `as _rsb`) by exact name. Any new callable taking over a
named role must keep that exact name, or the test import must be mechanically updated to the
new module path (not a "weakened" test).

**Hazard — `monkeypatch.setattr` pins the module attribute, not just the name**
(`tests/services/test_insights_llm.py:3005`):
```python
monkeypatch.setattr("app.services.insights_llm.get_insights_agent", lambda: fake)
```
`get_insights_agent` and its sole caller (the Sentry-guarded helper around line 2424) must
either both stay in `insights_llm.py`, or the caller must call via qualified module access.
Simplest: don't move this pair. Also verified module-attribute access from
`app/routers/insights.py:218,232` for `insights_llm._PROMPT_VERSION` and
`insights_llm._maybe_strip_overview` — these two names must remain importable as
`insights_llm.<name>` after any split.

**Assumption to verify before splitting:** grep `tests/services/test_insights_llm.py` for
`assert.*in user_prompt` / `assert user_prompt ==` snapshot-style assertions; if none exist, add
a golden-prompt test before splitting `_assemble_user_prompt` (RESEARCH.md Assumption A1).

---

### `app/services/tactic_detector.py` (service, dispatcher split)

**Analog:** itself (`detect_tactic_motif`, lines 2413-2587)

**Core dispatcher-pipeline pattern:**
```python
# Source shape, app/services/tactic_detector.py:2413-2587
def detect_tactic_motif(board_after_flaw, pv_str, has_forced_mate=False):
    ...guard clauses...
    if _can_run_mate:
        ...Tier 1 mate dispatch, ~5 early returns...   # Stage 1
    candidates = []
    ...Tier 2/3/4/5 collection loops...                 # Stage 2
    if not candidates:
        return None, None, None, None
    winner = min(candidates, key=_sort_key)              # Stage 3
    return winner[5], winner[2], winner[3], winner[4]
```
Split into `_dispatch_mate_tier(boards, moves, pov, has_forced_mate) -> tuple[...] | None`
(short-circuits, `None` on fall-through), `_collect_non_mate_candidates(boards, moves, pov) ->
list[Candidate]` (Tiers 2-5), `_select_shallowest_candidate(candidates) -> Candidate` (the
`min(..., key=_sort_key)` call). `detect_tactic_motif` becomes: parse PV → try mate tier →
else collect + select.

**Byte-identity oracle (not the standard pytest suite alone):**
```bash
PYTHONPATH=. uv run python scripts/tactic_tagger_report.py --check-goals
```
Compare **report content** byte-for-byte, not exit code — the script legitimately exits 1
both before and after (2 of 27 goal dimensions are pre-existing known gaps, unrelated to this
phase).

**Private helpers pinned by test import:** `_INT_TO_MOTIF`, `_parse_pv` — keep these names/
locations importable from `app.services.tactic_detector`.

---

### `app/repositories/train_repository.py` (repository, composition split)

**Analog:** itself (`reveal_for_puzzle`, `load_session_puzzles`, `compose_and_materialize_session`) + shared filter path `apply_game_filters`

**Shared filter import** — same convention as `library_repository.py`, confirmed importing
`apply_game_filters` from `app.repositories.query_utils`. Any split must preserve this as the
sole call site.

**Thin-seam flag (mutation-test REQUIRED):** zero private helpers are imported by name in
`tests/repositories/test_train_repository.py` — after splitting `compose_and_materialize_session`
et al., revert one extracted helper and confirm an existing test in that file fails, before
trusting the split.

---

### `pyproject.toml` — ruff lint config + dev dependency additions

**Existing `[tool.ruff]` block verbatim** (`pyproject.toml:76-87`):
```toml
[tool.ruff]
line-length = 100

[tool.ruff.lint.per-file-ignores]
"app/models/*.py" = ["F821"]  # SQLAlchemy forward references in relationship() strings
"alembic/versions/*.py" = ["F401"]  # Alembic auto-imports sa/op that may appear unused

[tool.ty.environment]
# Scripts in scripts/ are run as `python scripts/foo.py`, so sibling modules
# resolve via sys.path[0] at runtime. ty has no such implicit path, so
# scripts/ importing scripts/ reads as unresolved-import without this.
extra-paths = ["scripts"]
```
There is currently **no** `[tool.ruff.lint]` `select`/`extend-select` block — the new
`[tool.ruff.lint]` table with `extend-select = ["C901", "PLR0912", "PLR0915"]` plus
`[tool.ruff.lint.mccabe]` and `[tool.ruff.lint.pylint]` sub-tables is a pure addition, not a
merge into an existing list. `[tool.ruff.lint.per-file-ignores]` already exists — the 14
baseline per-file-ignore lines are ADDED to this existing table (two existing entries,
`app/models/*.py` and `alembic/versions/*.py`, stay unchanged above the new entries).

**Existing `[dependency-groups]` layout** (`pyproject.toml:25-40`):
```toml
[dependency-groups]
dev = [
    "pillow>=12.3.0",
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "pytest-cov>=7.1.0",
    "pytest-xdist>=3.8.0",
    "ruff>=0.4.0",
    "ty>=0.0.26",
    "zstandard>=0.22",
]
# Isolated group for backend Maia-3 ONNX inference (Phase 174, GEMS-06). Kept OUT
# of [project.dependencies] on purpose: that set is shared with the lean remote-worker
# image (Dockerfile.worker), which must never pull onnxruntime/numpy. Only the backend
# Dockerfile opts in via `uv sync --group maia-inference`.
maia-inference = [
```
`complexipy` is dev-only tooling with no lean-image constraint (unlike `maia-inference`/`push`)
— it belongs in the existing `dev` group, added via `uv add --dev complexipy` (targets `dev`
automatically, no new group needed).

## Shared Patterns

### Router import style (no downstream import edits needed after a split)

**Source:** `app/routers/endgames.py:1-24`
```python
from app.services import endgame_service
...
return await endgame_service.get_endgame_overview(...)
```
**Apply to:** all six split files. This module-attribute-access style (not
`from app.services.endgame_service import get_endgame_overview`) means every router keeps
working unmodified after an internal split, PROVIDED the top-level module keeps re-exposing
every currently-public name as a module attribute — either the function body stays in the
original file, or the file does `from app.services.endgame_service_clock import
_iterate_clock_rows` so the name still resolves as `endgame_service.<name>`.

### Module-split convention: sibling `.py` file, not a package

**Source:** RESEARCH.md, `[VERIFIED: find app/services app/repositories -maxdepth 1 -type d]`
— zero existing precedent for a service/repository split into a package
(`app/services/<name>/__init__.py`). Every service and repository is a flat `.py` file (32 in
`app/services/`, 21 in `app/repositories/`).

**Apply to:** any of the six files that extracts a cohesive helper cluster into a separate
file. Use a sibling flat file, e.g. `app/services/endgame_service_clock.py`,
`app/services/eval_apply_oracle.py`, `app/repositories/train_repository_session.py`. The main
file does `from app.services.endgame_service_clock import _iterate_clock_rows` at the top so
both the router's attribute-access pattern and any test importing a private helper by its
original dotted path (`from app.services.endgame_service import _iterate_clock_rows`) keep
working with zero downstream import-path edits.

### Sentry capture-site inventory (must not move out of their owning stage)

**Source:** RESEARCH.md `grep -n "sentry_sdk\."` full inventory
- `endgame_service.py`: 1 site, lines 512-517 (per-row `endgame_class is None` branch)
- `train_repository.py`, `library_repository.py`, `tactic_detector.py`: 0 sites
- `eval_apply.py`: 6 sites across 3 locations — 244-246/275-277 (function not yet profiled,
  read `eval_apply.py:200-330` before splitting), 1312-1317 (stage 5 of the
  `_classify_and_fill_oracle` pipeline), 2153-2154/2233-2234 (inside
  `_build_best_move_candidates`, 2074-2235)
- `insights_llm.py`: 3 sites, lines 2433-2471, inside the small helper immediately preceding
  `generate_insights` — do not merge this helper into an extracted prompt-assembly function

**Apply to:** every split — Sentry capture sites move together with the branch/try-except
block they guard; never split a try/except across a function boundary.

### Function-size/complexity gates (apply to every extracted helper)

**Source:** `pyproject.toml` (after Plan 1 lands) + `scripts/check_function_size.py`
- `uv run ruff check --select C901,PLR0912,PLR0915 <file>` — zero remaining per-file-ignore
  for the six in-scope files by the file's own plan merge
- `uv run --with complexipy complexipy <file> --max-complexity-allowed 15 --failed` — record
  before/after count in VERIFICATION
- `uv run python scripts/check_function_size.py <file> --fail-over-depth 4 --fail-over-loc 200`

## No Analog Found

None — this phase's file set is a closed set of behavior-preserving splits of existing files
plus one genuinely new stdlib-only script, and a strong CLI analog exists for the latter.

## Metadata

**Analog search scope:** `scripts/*.py` (argparse/docstring conventions), `app/services/`,
`app/repositories/` (flat-file convention, TypedDict precedent), `app/routers/endgames.py`
(import style), `pyproject.toml` (`[tool.ruff]`, `[dependency-groups]`), `docs/dev-tooling.md`
**Files scanned:** ~30 `scripts/*.py` filenames, 2 scripts read in full/excerpt
(`validate_multipv_budget.py`, `gen_flaw_thresholds_ts.py`), `stats_service.py` excerpt,
`endgames.py` router head, `pyproject.toml` lines 25-107, `docs/dev-tooling.md` lines 1-32
**Pattern extraction date:** 2026-09-02
