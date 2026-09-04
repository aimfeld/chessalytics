---
phase: 214-backend-god-file-decomposition
plan: 08
subsystem: infra
tags: [ruff, complexipy, verification, closeout, concerns]

# Dependency graph
requires:
  - phase: 214-01
    provides: "ruff C901/PLR0912/PLR0915 enabled with a baselined per-file-ignores table; scripts/check_function_size.py; complexipy dev dependency"
  - phase: 214-02
    provides: "tactic_detector.py split, ignore-entry deleted"
  - phase: 214-03
    provides: "endgame_service.py aggregation split, ignore-entry deleted"
  - phase: 214-04
    provides: "library_repository.py flaw-filter split, ignore-entry deleted"
  - phase: 214-05
    provides: "eval_apply.py transactional pipeline split, ignore-entry deleted"
  - phase: 214-06
    provides: "train_repository.py session-composition split, ignore-entry deleted"
  - phase: 214-07
    provides: "insights_llm.py prompt-assembler split, ignore-entry deleted"
provides:
  - "Phase-wide after-baseline measured against all five ROADMAP success criteria, with commands and numbers recorded"
  - "CONCERNS.md 'Large God files' entry narrowed to name only the four remaining frontend files"
affects: []

# Actuals (#2632) -- chars/4 over the realized diff (git diff HEAD~1..HEAD for the
# one touched file), not a harness token count.
actuals:
  tokens: 866
  tasks: 2
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Measurement-only tracer task with no commit: Task 1 modifies no files (verification only), so it produces no per-task commit -- only Task 2's documentation edit is committed."

key-files:
  created: []
  modified:
    - .planning/codebase/CONCERNS.md

key-decisions:
  - "ROADMAP success criterion 1 ('No function in the six files exceeds 200 logic LOC or nesting depth 4') is satisfied -- each of the six in-scope files individually passes `check_function_size.py <file> --fail-over-depth 4 --fail-over-loc 200` with zero breaches. The plan's own Task 1 acceptance-criteria command, `check_function_size.py app/services app/repositories --fail-over-depth 4 --fail-over-loc 200` (broader than the six files), exits 1 because six PRE-EXISTING, out-of-scope functions elsewhere in those two directories breach nesting depth. This is a plan-authoring scope mismatch (the literal verify command is broader than the ROADMAP criterion it's meant to prove), not a phase failure -- recorded here per the plan's own instruction to 'stop and report... do not patch app/ code from this plan' rather than fixed, since fixing would touch out-of-scope files this plan is explicitly forbidden from modifying."
  - "Corrected the orchestrator-supplied pre-measurement: it named three out-of-scope depth breaches (lichess_client.py, openings_service.py, user_benchmark_percentiles_service.py). Re-running `check_function_size.py app/` here found SIX: those three plus `app/services/chesscom_client.py:375 fetch_chesscom_games_backward` (depth 5), `app/services/import_service.py:1010 _make_game_iterator` (depth 5), and `app/services/library_service.py:478 _build_card` (depth 5). All six are pre-existing, unrelated to this phase's six in-scope files, and untouched here -- see the before/after table below."
  - "`gsd-tools windows append` was attempted for the deviation above but returned a pre-existing ledger/table desync error ('disagrees with the fenced JSON entries for row id(s): 8') unrelated to this plan; nothing was written to WINDOWS.md. Per the SUMMARY protocol this is best-effort, non-blocking -- the deviation is fully documented in this SUMMARY instead."

requirements-completed: []

coverage:
  - id: D1
    description: "Phase-wide after-baseline measured against all five ROADMAP success criteria (0, 1, 2, 3, 4) with commands and numbers recorded in this SUMMARY"
    verification:
      - kind: other
        ref: "uv run ruff check . (0 findings, exits 0)"
        status: pass
      - kind: other
        ref: "uv run ruff check <six in-scope files> --config 'lint.per-file-ignores = {}' (0 findings, exits 0)"
        status: pass
      - kind: other
        ref: "uv run python scripts/check_function_size.py <each of the six files individually> --fail-over-depth 4 --fail-over-loc 200 (all six: OK, exit 0)"
        status: pass
      - kind: other
        ref: "uv run ruff format --check app/ tests/ scripts/ && uv run ty check app/ tests/ scripts/ && uv run --project analysis --with ty ty check analysis/ && uv run pytest -n auto -x -q (all clean; 4497 passed, 19 skipped)"
        status: pass
      - kind: other
        ref: "git diff --numstat 6bee7ca0c..HEAD -- tests/ (0 deletions on every row)"
        status: pass
      - kind: other
        ref: "git diff 6bee7ca0c..HEAD -- app/ scripts/ tests/ | grep -c '^+.*# ty: ignore' (0)"
        status: pass
    human_judgment: true
    rationale: "The plan's own Task 1 acceptance-criteria command for criterion 1 (check_function_size.py scoped to app/services + app/repositories broadly) exits 1 due to 6 pre-existing out-of-scope depth breaches -- a plan-authoring scope mismatch against the ROADMAP criterion, which the six in-scope files satisfy individually. A human should confirm this interpretation (measure-and-report, not a phase failure) is the correct read before the phase is considered closed."
  - id: D2
    description: "CONCERNS.md 'Large God files' entry narrowed to name only the four frontend files, with current line counts, a frontend-scoped fix approach, and a Phase 214 history line"
    verification:
      - kind: other
        ref: "grep -A8 'Large \"God files\"' .planning/codebase/CONCERNS.md | grep '^- Files:' | grep -c 'app/' (0)"
        status: pass
      - kind: other
        ref: "grep -A8 'Large \"God files\"' .planning/codebase/CONCERNS.md | grep -c 'frontend/src/pages/Analysis.tsx' (1)"
        status: pass
      - kind: other
        ref: "git diff --stat -- .planning/codebase/CONCERNS.md (only file touched)"
        status: pass
    human_judgment: false

duration: ~25min
completed: 2026-09-03
status: complete
---

# Phase 214 Plan 08: Phase-Wide Closeout and Verification Summary

**All five ROADMAP success criteria measured against the merged trunk (ruff clean project-wide, the six in-scope files individually breach-free on both complexity and size/depth gates, full pre-merge gate green, tests-additions-only, zero new `# ty: ignore`), and the CONCERNS.md "Large God files" entry retired to name only the four remaining frontend files.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-03T04:46:23Z
- **Tasks:** 2
- **Files modified:** 1 (`.planning/codebase/CONCERNS.md`)

## Accomplishments

- **Criterion 0 (ruff, project-wide and six-file):** `uv run ruff check .` exits 0 (all checks pass). The six in-scope files with the ignore table emptied on the command line (`app/services/endgame_service.py app/repositories/train_repository.py app/services/eval_apply.py app/repositories/library_repository.py app/services/insights_llm.py app/services/tactic_detector.py`) also exit 0 -- zero findings, independent of `pyproject.toml`. The project-wide ignore-emptied `C901`/`PLR0912`/`PLR0915` count dropped from the 214-01 baseline of **52 findings / 24 files** to **31 findings** now -- the residue is entirely the eight out-of-scope files 214-01 already flagged as out of scope (no in-scope file contributes any longer).
- **Criterion 0b (complexipy):** App-wide over-threshold-15 count dropped from the 214-01 baseline of **97** to **89** (-8). Per-file, all six in-scope files dropped or held (none increased) -- see the before/after table below.
- **Criterion 1 (size and depth):** Each of the six in-scope files individually passes `scripts/check_function_size.py <file> --fail-over-depth 4 --fail-over-loc 200` with **zero breaches** (was 6 breaches across 3 files at the 214-01 baseline: 3 in `endgame_service.py`, 1 in `library_repository.py`, 2 in `insights_llm.py`). The 100-200-logic-LOC survivor listing (7 functions, none breaching) is recorded below with justifications, plus the one `allow_loc` exemption (`fetch_flaw_comparison`).
- **Criterion 2 (full gate, tests additions-only):** `ruff format --check`, `ruff check .`, `ty check app/ tests/ scripts/`, `ty check analysis/`, and `pytest -n auto -x -q` (4497 passed, 19 skipped) are all green. `git diff --numstat 6bee7ca0c..HEAD -- tests/` shows **0 deletions on every row** -- the only changed test rows are `tests/scripts/test_check_function_size.py` (316/0, new), `tests/services/golden/insights_user_prompt.txt` (83/0, new), and `tests/services/test_insights_llm.py` (191/0, existing file with only additions).
- **Criterion 3 (no new suppressions, growth from deliberate splits only):** `git diff 6bee7ca0c..HEAD -- app/ scripts/ tests/ | grep -c '^+.*# ty: ignore'` prints **0**. `git diff --stat 6bee7ca0c..HEAD` shows 25 files changed (4,810 insertions / 1,547 deletions); the only new files under `app/`, `scripts/`, or `tests/` are `scripts/check_function_size.py`, `tests/scripts/test_check_function_size.py`, and `tests/services/golden/insights_user_prompt.txt` -- exactly the three the plan expected. No in-scope module was split into a sibling file.
- **Criterion 4 (CONCERNS.md):** the "Large God files" entry now names only the four `frontend/` paths, with current `wc -l` counts, a frontend-scoped fix approach naming the eslint `complexity`/`max-depth` follow-up, and a history line recording the Phase 214 backend decomposition.

## Task Commits

1. **Task 1: Measure the phase-wide after-baseline** -- no commit (measurement only; no file is modified by this task, per its own scope).
2. **Task 2: Retire the backend half of the CONCERNS.md entry** -- `16ce9b1cc` (docs)

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

## Files Created/Modified

- `.planning/codebase/CONCERNS.md` -- "Large God files" entry rewritten: Issue/Files/Impact/Fix-approach reframed around the four frontend files only, plus a new History line recording the Phase 214 backend decomposition and its date. The neighbouring `# ty: ignore` suppressions concern is untouched.

## Before/After Tables

### Ruff (C901/PLR0912/PLR0915)

| Measure | 214-01 baseline | Now (214-08) |
|---|---:|---:|
| `ruff check .` (with pyproject ignores) | 0 findings (all baselined) | 0 findings |
| Six in-scope files, ignore table emptied on the CLI | 35 findings (14 files, app/-scoped) [^1] | 0 findings |
| Whole-repo, ignore table emptied on the CLI | 52 findings / 24 files | **31 findings** |

[^1]: 214-01's app/-scoped measurement covered 14 files including 8 out-of-scope `app/` files beyond the six in-scope ones; the whole-repo figure (52/24) is the correct comparison baseline for "ignore table emptied" since it is what `ruff check .` actually scans.

### Complexipy (cognitive complexity > 15, report-only, not CI-gated)

| File | 214-01 baseline | Now (214-08) | Δ |
|---|---:|---:|---:|
| App-wide total | 97 | 89 | -8 |
| `endgame_service.py` | 12 | 10 | -2 |
| `train_repository.py` | 5 | 4 | -1 |
| `eval_apply.py` | 8 | 7 | -1 |
| `library_repository.py` | 3 | 3 | 0 (by design -- `build_flaw_filter_clauses`'s four inline family blocks stay inline per 214-04's decision) |
| `insights_llm.py` | 12 | 9 | -3 |
| `tactic_detector.py` | 16 | 15 | -1 |

### `check_function_size.py` (nesting depth > 4 or logic LOC > 200 -- CI-relevant per this phase)

| File | 214-01 baseline breaches | Now (214-08) |
|---|---|---|
| `endgame_service.py` | 3 (`_aggregate_endgame_stats` LOC 251>200; `_aggregate_endgame_stats_by_tc` depth 5; `_compute_per_tc_metric_cards` depth 5) | **0 -- OK: 51 functions scanned** |
| `train_repository.py` | 0 | **0 -- OK: 36 functions scanned** |
| `eval_apply.py` | 0 | **0 -- OK: 51 functions scanned** |
| `library_repository.py` | 1 (`fetch_flaw_comparison` LOC 243>200) | **0 -- OK: 34 functions scanned** (now exempted via `allow_loc`, see below) |
| `insights_llm.py` | 2 (`_format_zone_bounds` depth 6; `_assemble_user_prompt` depth 5) | **0 -- OK: 60 functions scanned** |
| `tactic_detector.py` | 0 | **0 -- OK: 51 functions scanned** |

**Out-of-scope residue** -- `check_function_size.py app/services app/repositories --fail-over-depth 4 --fail-over-loc 200` (the plan's literal Task 1 command, broader than the six in-scope files) still exits 1 with **six** pre-existing depth breaches, all outside this phase's scope and untouched by any of the seven Phase 214 plans:

```
app/services/chesscom_client.py:375: fetch_chesscom_games_backward -- depth 5 > 4
app/services/import_service.py:1010: _make_game_iterator -- depth 5 > 4
app/services/library_service.py:478: _build_card -- depth 5 > 4
app/services/lichess_client.py:51: fetch_lichess_games -- depth 6 > 4
app/services/openings_service.py:282: get_time_series -- depth 5 > 4
app/services/user_benchmark_percentiles_service.py:505: compute_stage_b -- depth 5 > 4
```

This is a correction to the orchestrator-supplied pre-measurement, which named only three of these six (`lichess_client.py`, `openings_service.py`, `user_benchmark_percentiles_service.py`) -- see Deviations below. None are in the six in-scope files; ROADMAP success criterion 1 ("No function in the six files exceeds 200 logic LOC or nesting depth 4") is satisfied by the per-file results in the table above, not by this broader command.

## 100-200 Logic-LOC Survivors (across all six in-scope files)

`scripts/check_function_size.py --json` per file, filtered to `100 <= logic_loc <= 200`:

| File | Function | logic_loc | depth | Justification |
|---|---|---:|---:|---|
| `endgame_service.py` | `get_endgame_overview` | 199 | 1 | Pre-existing, untouched. A fetch-and-assemble orchestrator whose body is a sequence of awaited repository calls; depth 1, no ruff finding. |
| `endgame_service.py` | `_build_category_stats` | 137 | 2 | New shared per-class builder from 214-03, replacing two ~130-line near-duplicate loop bodies. Depth 2 throughout; no ruff finding. |
| `endgame_service.py` | `_get_endgame_performance_from_rows` | 127 | 4 | Pre-existing, untouched. A single statistical pass; no ruff finding. |
| `insights_llm.py` | `_render_subsection_block` | 114 | 3 | Pre-existing; already brought under `PLR0912` by 214-07's `_group_findings_by_metric_dim`/`_apply_c5_filter` extractions. No ruff finding. |
| `train_repository.py` | `record_solve` | 119 | 3 | Pre-existing, untouched by 214-06. No ruff finding. |
| `eval_apply.py` | `apply_full_eval` | 105 | 1 | Pre-existing, untouched. Depth 1; no ruff finding. |
| `eval_apply.py` | `_apply_bestmove_submit` | 100 | 3 | Pre-existing, untouched. Right at the 100-LOC soft threshold; no ruff finding. |

**One `allow_loc` exemption exists**, outside the 100-200 band above (it is exempted specifically because it exceeds 200):

| File | Function | logic_loc | Reason |
|---|---|---:|---|
| `library_repository.py` | `fetch_flaw_comparison` | 243 | "one select() with ~30 labelled COUNT(...).filter(...) column expressions (15 metrics x player/opp); PLR0915 (statement count) does not fire, confirming the length is a literal-heavy column list, not control-flow complexity" (214-04) |

## Decisions Made

See `key-decisions` in frontmatter -- three decisions: (1) ROADMAP criterion 1 is satisfied by the six in-scope files individually, even though the plan's own broader Task 1 verify command fails on pre-existing out-of-scope residue; (2) corrected the orchestrator's undercounted out-of-scope depth-breach list from three to six files; (3) the `windows append` ledger-sync attempt hit a pre-existing, unrelated corruption and was skipped per the best-effort protocol.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Plan/reality scope mismatch] Task 1's literal `check_function_size.py app/services app/repositories` acceptance-criteria command fails on pre-existing out-of-scope residue**
- **Found during:** Task 1, running the acceptance-criteria verification loop
- **Issue:** The plan's task 1 acceptance criteria require `uv run python scripts/check_function_size.py app/services app/repositories --fail-over-depth 4 --fail-over-loc 200` to exit 0. This command scans the entirety of both directories, not just the six in-scope files. It exits 1 because six pre-existing functions elsewhere in `app/services/` breach nesting depth (`chesscom_client.py`, `import_service.py`, `library_service.py`, `lichess_client.py`, `openings_service.py`, `user_benchmark_percentiles_service.py`) -- none of which are in this phase's scope, and none of which any of the seven Phase 214 plans touched. ROADMAP success criterion 1 is explicitly scoped to "the six files," which this plan's task 1 `<action>` text and `must_haves.truths` also state ("No function in the six in-scope files exceeds..."). The literal verify command the plan authored is broader than the criterion it is meant to prove.
- **Fix:** Did not modify any `app/` file (forbidden by this plan's own prohibitions -- "No app/ source file is modified in this plan"). Instead measured each of the six in-scope files individually (`check_function_size.py <file> --fail-over-depth 4 --fail-over-loc 200`), confirming all six exit 0 with zero breaches, which is the actual proof ROADMAP criterion 1 asks for. Recorded the broader command's six-item residue as an explicit "out-of-scope residue" table above rather than silently omitting the failing command's output.
- **Files modified:** none (measurement/documentation only, in this SUMMARY)
- **Verification:** all six per-file `check_function_size.py` runs exit 0; the broader command's failure is fully reproduced and quoted above.
- **Committed in:** n/a (Task 1 makes no code commit)

**2. [Rule 1 - Data correction] Orchestrator-supplied pre-measurement undercounted the out-of-scope depth-breach residue**
- **Found during:** Task 1, re-running the exact commands the orchestrator's `<orchestrator_measurements>` context block had already run
- **Issue:** The orchestrator's context stated "three depth breaches in files OUTSIDE this phase's scope: `lichess_client.py`, `openings_service.py`, `user_benchmark_percentiles_service.py`." Re-running `check_function_size.py app/` (and the narrower `app/services app/repositories` scope) found six, not three -- the same three plus `chesscom_client.py:375`, `import_service.py:1010`, and `library_service.py:478`.
- **Fix:** Recorded the corrected, complete six-item list in this SUMMARY's before/after table (see "Out-of-scope residue" above) rather than repeating the incomplete three-item claim.
- **Files modified:** none (documentation only)
- **Verification:** command output quoted verbatim above; reproducible by re-running `uv run python scripts/check_function_size.py app/ --fail-over-depth 4 --fail-over-loc 200`.
- **Committed in:** n/a

---

**Total deviations:** 2 auto-fixed/documented (1 plan-authoring scope mismatch handled by measuring the correctly-scoped proof instead of patching out-of-scope code, 1 factual correction to orchestrator-supplied context).
**Impact on plan:** No scope creep, no code changed beyond the sanctioned `.planning/codebase/CONCERNS.md` edit. Both deviations are measurement/documentation corrections that keep the phase's closeout claim accurate rather than either silently accepting an incomplete claim or overreaching into out-of-scope files to force a broader command green.

## Issues Encountered

- **`gsd-tools windows append` ledger desync.** Attempted to record deviation 1 above in `.planning/WINDOWS.md` per the broken-windows-ledger convention; the command returned `Error: Ledger table in .../WINDOWS.md disagrees with the fenced JSON entries (the sole source of truth) for row id(s): 8` -- a pre-existing corruption unrelated to this plan. Nothing was written (`git status --short .planning/WINDOWS.md` confirms no change). Per the SUMMARY protocol this population step is best-effort and non-blocking; the deviation is fully documented in this SUMMARY's Deviations section instead. The WINDOWS.md row-8 desync itself is out of this plan's scope to fix.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- All six Phase 214 in-scope files (`tactic_detector.py`, `endgame_service.py`, `library_repository.py`, `eval_apply.py`, `train_repository.py`, `insights_llm.py`) carry no ruff complexity exemption, individually pass `check_function_size.py` with zero breaches, and are covered by unchanged (or additions-only) test oracles.
- `CONCERNS.md` "Large God files" now points at the four frontend files as the only remaining god-file debt, with a Phase 214 history line so the entry's narrowing is not mistaken for an oversight.
- Phase 214 is ready for the pre-merge gate and squash-merge to `main` per `docs/git-workflow.md` -- the full pre-merge gate (ruff format, ruff check, ty x2, full pytest) was re-verified green in this plan.
- `.planning/WINDOWS.md`'s row-8 table/JSON desync is a pre-existing, unrelated defect that should be repaired before it blocks a future `gsd_run windows append` call from some other plan.
- The six out-of-scope `check_function_size.py` depth breaches (`chesscom_client.py`, `import_service.py`, `library_service.py`, `lichess_client.py`, `openings_service.py`, `user_benchmark_percentiles_service.py`) remain open, pre-existing debt -- not introduced or worsened by this phase, and out of its scope to fix.

## Self-Check: PASSED

- `.planning/codebase/CONCERNS.md` -- FOUND on disk, "Large God files" entry confirmed narrowed (`grep -A8 'Large "God files"' .planning/codebase/CONCERNS.md | grep '^- Files:' | grep -c 'app/'` -> 0)
- Commit `16ce9b1cc` -- FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>`: `uv run ruff check .` (clean), six-file ignore-emptied ruff check (clean), `uv run python scripts/check_function_size.py <each of six files>` (all OK, exit 0), complexipy app-wide (89, below the 97 baseline), full pre-merge gate (`ruff format --check`, `ruff check .`, `ty check app/ tests/ scripts/`, `ty check analysis/`, `pytest -n auto -x -q` -- 4497 passed, 19 skipped), `git diff --numstat 6bee7ca0c..HEAD -- tests/` (0 deletions every row), `git diff 6bee7ca0c..HEAD -- app/ scripts/ tests/ | grep -c '^+.*# ty: ignore'` (0)

---
*Phase: 214-backend-god-file-decomposition*
*Completed: 2026-09-03*
