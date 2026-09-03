---
phase: 214-backend-god-file-decomposition
plan: 04
subsystem: repositories
tags: [ruff, complexipy, library-repository, refactor, loc-exemption]

# Dependency graph
requires:
  - phase: 214-01
    provides: "ruff C901/PLR0912/PLR0915 enabled with a baselined per-file-ignores table; scripts/check_function_size.py with the allow-loc pragma contract"
provides:
  - "app/repositories/library_repository.py's build_flaw_filter_clauses split via one named tactic-clause helper (_build_tactic_clause), zero complexity exemption"
  - "fetch_flaw_comparison recorded as a reasoned # check-function-size: allow-loc exemption instead of being split"
affects: [214-05, 214-06, 214-07]

# Actuals (#2632)
actuals:
  tokens: 2479
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Narrow single-block extraction: only the one substantial family block (tactic, ~30 lines with a nested loop) is extracted; the four smaller 3-8 line family blocks (severity/tempo/opportunity/impact/phase) stay inline to avoid over-splitting"
    - "Reasoned LOC exemption pragma: a function long in lines but not in logic (one large select() with ~30 labelled column expressions, PLR0915 not firing) gets a `# check-function-size: allow-loc <reason>` pragma citing that ruff signal, instead of a damaging split"
    - "Mutation proof as SUMMARY-recorded evidence: stub the extracted helper's body with an immediate `return None`, confirm the suite goes red, restore, confirm green again"

key-files:
  created: []
  modified:
    - app/repositories/library_repository.py
    - pyproject.toml

key-decisions:
  - "_build_tactic_clause receives the raw tactic_families param and does the family-to-motif-int resolution (motif_ints, resolved_families) itself, matching the plan's exact five-parameter signature -- the caller only checks the None return, it does not pre-resolve anything."
  - "The allow-loc pragma reason is a single line (ruff's own PLR0915-not-firing signal plus the ~30-column-select description) placed directly above `def fetch_flaw_comparison`, with a separate three-line explanatory comment block above that -- the pragma parser only reads the line immediately above the def, so the reason had to be self-contained on that one line."

requirements-completed: []

coverage:
  - id: D1
    description: "build_flaw_filter_clauses brought inside ruff's max-branches=12 via one extraction: _build_tactic_clause(tactic_families, orientation, min_tactic_depth, max_tactic_depth, decided_lost) -> ColumnElement[bool] | None; the four other family blocks (severity/tempo/opportunity/impact/phase) stay inline"
    requirement: null
    verification:
      - kind: unit
        ref: "tests/test_library_repository.py + tests/repositories/test_library_repository.py + tests/services/test_library_service.py + tests/services/test_flaw_comparison.py + tests/test_flaw_predicate.py (181 passed, unchanged from pre-change baseline)"
        status: pass
      - kind: other
        ref: "uv run ruff check app/repositories/library_repository.py --config 'lint.per-file-ignores = {}' (no PLR0912 finding on build_flaw_filter_clauses)"
        status: pass
      - kind: other
        ref: "mutation proof -- stubbing _build_tactic_clause to `return None` unconditionally turns 30 tests red across three test modules; restoring returns 181/181 green"
        status: pass
    human_judgment: false
  - id: D2
    description: "fetch_flaw_comparison (243 logic LOC, one select() with ~30 labelled column expressions) exempted via a reasoned # check-function-size: allow-loc pragma instead of being split; library_repository.py's per-file-ignores entry deleted from pyproject.toml"
    requirement: null
    verification:
      - kind: other
        ref: "uv run python scripts/check_function_size.py app/repositories/library_repository.py --fail-over-depth 4 --fail-over-loc 200 --json (allow_loc: true for fetch_flaw_comparison only, exit 0)"
        status: pass
      - kind: other
        ref: "uv run ruff check app/repositories/library_repository.py && uv run ruff check app/repositories/library_repository.py --config 'lint.per-file-ignores = {}' && uv run ruff check . (all exit 0)"
        status: pass
      - kind: unit
        ref: "uv run pytest -n auto -x -q (4496 passed, 19 skipped, 0 failed -- full backend suite)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-09-02
status: complete
---

# Phase 214 Plan 04: Library Repository Flaw-Filter Split Summary

**`build_flaw_filter_clauses` brought inside ruff's branch limit via one named `_build_tactic_clause` helper, `fetch_flaw_comparison` recorded as a reasoned `allow-loc` exemption instead of split, and `library_repository.py`'s complexity ignore-entry deleted — proven behavior-identical by an unchanged 181-test passed count and a mutation proof.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-09-02T20:50:30Z
- **Tasks:** 2
- **Files modified:** 2 (`app/repositories/library_repository.py`, `pyproject.toml`)

## Accomplishments

- `_build_tactic_clause(tactic_families, orientation, min_tactic_depth, max_tactic_depth, decided_lost) -> ColumnElement[bool] | None` now owns the tactic-family clause: family-string-to-motif-int resolution, the `_tactic_orientation_pairs` loop, and the decided-lost suppression — returning `None` when no tactic control is active. The 260621-sm8 bug-fix comments moved with the code they explain.
- The severity, tempo, opportunity, impact, and phase blocks stay inline inside `build_flaw_filter_clauses` (3-8 lines each, one caller) — no over-splitting into five one-shot helpers.
- `build_flaw_filter_clauses` is now inside `max-branches = 12` (was `PLR0912 13>12`); `uv run ruff check app/repositories/library_repository.py --config 'lint.per-file-ignores = {}'` reports zero findings for the file (not just the tactic block).
- `fetch_flaw_comparison` (243 logic LOC, a single `select()` with ~30 labelled `COUNT(...).filter(...)` column expressions) carries a `# check-function-size: allow-loc` pragma citing `PLR0915` not firing as the evidence — the correct signal for "long in lines, not long in logic" per `214-RESEARCH.md` Pitfall 1.
- `library_repository.py`'s `per-file-ignores` entry deleted from `pyproject.toml`; `uv run ruff check .` stays green project-wide.
- Mutation proof: stubbing `_build_tactic_clause` to `return None` unconditionally turns 30 tests red across `tests/test_library_repository.py`, `tests/repositories/test_library_repository.py`, and `tests/test_flaw_predicate.py`; restoring the body returns the suite to 181/181 green — the extraction is genuinely exercised, not merely present.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract the tactic clause from build_flaw_filter_clauses** — `6aff057e5` (feat) — tracer task, verified end-to-end (pytest 181/181 + ruff PLR0912 clean + ty/ruff-format clean) before expanding.
2. **Task 2: fetch_flaw_comparison LOC exemption, mutation proof, ignore-entry deletion** — `87a4dfcd4` (fix)

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

## Files Created/Modified

- `app/repositories/library_repository.py` — `_build_tactic_clause` added (127 lines including docstring, inserted before `build_flaw_filter_clauses`); `build_flaw_filter_clauses`'s tactic block reduced to a 5-line call + None-check; `# check-function-size: allow-loc` pragma added above `fetch_flaw_comparison`. `apply_game_filters` import and its three call sites untouched; `_TACTIC_CHIP_CONFIDENCE_MIN` stays importable at the same module path.
- `pyproject.toml` — deleted the `app/repositories/library_repository.py` `per-file-ignores` entry (`["PLR0912"]`).

## Decisions Made

- **`_build_tactic_clause` owns the family-to-motif-int resolution, not the caller.** The plan's five-parameter signature (`tactic_families, orientation, min_tactic_depth, max_tactic_depth, decided_lost`) takes the raw `tactic_families` sequence, so `motif_ints`/`resolved_families` computation moved into the helper along with the rest of the tactic logic — the caller now only branches on the `None` return.
- **Single-line pragma reason.** `scripts/check_function_size.py`'s `_pragma_for_def` only reads the source line immediately above the `def`, so the reason (citing `PLR0915` not firing and describing the ~30-column select) had to be one self-contained line; a separate three-line explanatory comment sits above the pragma line itself for readers, but is invisible to the tool.

## Deviations from Plan

None - plan executed exactly as written.

## Mutation Proof (recorded per Task 2)

Temporarily replaced `_build_tactic_clause`'s body with an immediate `return None  # MUTATION-TEST STUB`. Result: 30 tests failed —

```
FAILED tests/test_library_repository.py::TestTacticOrientationBuildFlawFilterClauses (4 tests)
FAILED tests/test_library_repository.py::TestTacticDepthAndEitherBuildFlawFilterClauses (8 tests)
FAILED tests/test_library_repository.py::TestDecidedLostSuppression (6 tests)
FAILED tests/test_library_repository.py::TestQueryFilteredGames (6 tests)
FAILED tests/test_library_repository.py::TestAnalyzedDenominator::test_tactic_filter_orientation_either_includes_missed_only_game
FAILED tests/repositories/test_library_repository.py::TestQueryFlawsPerSlotSuppression (2 tests)
FAILED tests/test_flaw_predicate.py::TestBuildFlawFilterClausesUnit (2 tests)
FAILED tests/test_flaw_predicate.py::TestFlawExistsFromTable::test_split_tactic_and_context_flaws_do_not_match
30 failed, 151 passed in 24.19s
```

Restored the original body (verified with a `diff` against the pre-mutation copy, zero differences): `181 passed` (green again, same count as the pre-change baseline). This confirms `214-PATTERNS.md`'s "oracle correction" — the seam is not thin; `build_flaw_filter_clauses` is fully exercised through `tests/test_library_repository.py`'s compiled-SQL helpers and `tests/test_flaw_predicate.py`'s end-to-end family semantics, even though only one constant is imported by name in tests.

## Complexipy Before/After (this file)

- **Before (214-01 baseline):** 3 functions over cognitive complexity 15.
- **After:** 3 functions over cognitive complexity 15 — unchanged count, but `build_flaw_filter_clauses` itself dropped from complexity 39 to 28 (Δ = -11); it remains over 15 because the four inline family blocks are still there by design (extracting them would over-split). `fetch_tactic_lines` (16) and `tactic_slot_visible` (30) are unrelated to this plan's scope and untouched. `_build_tactic_clause` itself is complexity 9 — well under the report-only threshold. Complexipy is report-only per 214-01's decision (not CI-gated); the CI-gated signal (`PLR0912`, branch count) is clean.

## 100-200 Logic-LOC Survivors

None. `scripts/check_function_size.py --json` on this file shows no function with `logic_loc` between 100 and 200 — the only function over 100 is the exempted `fetch_flaw_comparison` (243, exempted above 200). The largest non-exempt function is well under 100.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `app/repositories/library_repository.py` carries no complexity exemption in `pyproject.toml`; `ruff check .` stays green project-wide with one fewer baselined file.
- The narrow single-block-extraction + reasoned-exemption pattern (extract only the one substantial family block, exempt the one literal-heavy select() with a cited ruff tie-breaker signal) is now proven on the file the ROADMAP called "the phase's clearest test of judgement" — 214-05..214-07 can reference this file's before/after as a worked example of when NOT to split.
- Ready for the next wave-2 plan; no blockers.

## Self-Check: PASSED

- `app/repositories/library_repository.py` — FOUND on disk, contains `_build_tactic_clause` and the `allow-loc` pragma above `fetch_flaw_comparison`
- Commits `6aff057e5`, `87a4dfcd4` — both FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>`: five-module oracle (181 passed, unchanged), `uv run ruff check app/repositories/library_repository.py` clean with and without the ignore table, `uv run ruff check .` clean, `uv run python scripts/check_function_size.py app/repositories/library_repository.py --fail-over-depth 4 --fail-over-loc 200` (exit 0, exactly one `allow_loc` exemption), Sentry capture count 0, `uv run ty check app/ tests/ scripts/` (zero errors), `uv run ruff format --check app/ tests/ scripts/` (clean), `uv run pytest -n auto -x -q` (4496 passed, 19 skipped, 0 failed)

---
*Phase: 214-backend-god-file-decomposition*
*Completed: 2026-09-02*
