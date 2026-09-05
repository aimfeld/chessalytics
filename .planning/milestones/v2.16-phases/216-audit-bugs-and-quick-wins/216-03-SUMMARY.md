---
phase: 216-audit-bugs-and-quick-wins
plan: 03
subsystem: infra
tags: [uv, npm, dependency-management, ruff, ty, renovate]

# Dependency graph
requires: []
provides:
  - "uv.lock caught up within existing semver ranges (D-04), anthropic/complexipy majors untouched (D-05)"
  - "frontend/package-lock.json caught up within existing ranges via npm update, onnxruntime-web byte-identical"
  - "Full CLAUDE.md pre-merge gate (backend + frontend) green on the caught-up dependency set"
  - "pyproject.toml ruff select pin that prevents a ruff default-set expansion from silently widening lint scope on future bumps"
affects: [ci, dependency-automation]

# Actuals (#2632)
actuals:
  tokens: 240785
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Scoped `uv lock --upgrade-package` per name, never bare `uv lock --upgrade`, with a post-lock tripwire re-read on excluded majors"
    - "When a scoped upgrade cascades a tripwire package transitively, drop the package that pulled it (not the tripwire itself) from the upgrade set and re-lock, rather than hand-editing the lockfile"
    - "Pin an explicit `ruff.lint.select` baseline so a ruff version bump's own default-rule-set growth cannot silently expand what CI lints project-wide"

key-files:
  created: []
  modified:
    - uv.lock
    - frontend/package-lock.json
    - pyproject.toml
    - app/repositories/library_repository.py
    - app/schemas/position_bookmarks.py
    - app/services/insights_llm.py
    - scripts/gen_global_percentile_cdf.py
    - scripts/gen_persona_avatars.py
    - scripts/two_pawns_up/prod_selection_bias.py
    - tests/services/test_eval_drain.py
    - tests/test_last_activity_middleware.py
    - analysis/README.md

key-decisions:
  - "Dropped pydantic-ai-slim (and pydantic-graph) from the scoped upgrade set after a --dry-run re-lock proved bumping it alone cascades anthropic 0.122.0 -> 1.3.0 transitively (its `anthropic` extra now requires a newer floor) — a live demonstration of RESEARCH.md Assumption A3's cascade risk."
  - "Fixed all 11 diagnostics the ty 0.0.40 -> 0.0.78 bump newly surfaced (5 now-unused `ty: ignore` comments removed, 2 real dict[str, object] key-read narrowings via cast(), 1 list[int] -> list[float] retype for a fractional accumulator, 1 Optional narrowing before sort, 1 duck-typed-mock ignore split across its two actual diagnostic lines/rules) rather than deferring — Task 1's acceptance criteria required a zero-diagnostic ty check before Task 2 could start."
  - "Pinned pyproject.toml's ruff `select` to `[\"E4\", \"E7\", \"E9\", \"F\"]` after discovering ruff 0.15.15 -> 0.16.6 grew its own unconfigured default from 62 to 419 enabled rules (verified via `ruff check --isolated`) — running the gate against that expanded default surfaced ~2200 new findings across ~380 files (bandit blind-except, naive-datetime, and dozens of other categories never previously selected), which is out of scope for a no-behavior-change dependency catch-up and needs individual review per finding, not a blind batch fix. This is a deviation from the plan's literal instructions (which did not anticipate a ruff default-set expansion) but keeps SC-3's 'no product behavior change' constraint intact; see Deviations below for full reasoning and reversibility."
  - "Discarded (git checkout -- .) an over-broad `ruff check . --fix` result mid-task after diagnosing it was driven by ruff's own default-rule-set growth rather than real dependency-bump fallout — the discard only affected this task's own uncommitted, not-yet-reviewed working-tree state (Task 1/2 commits were unaffected), so no prior work was at risk."

requirements-completed: []

coverage:
  - id: D1
    description: "Python lockfile (uv.lock) caught up within existing semver ranges; anthropic stays 0.x and complexipy stays 7.x (D-05)"
    verification:
      - kind: unit
        ref: "uv run python -c \"...\" tripwire assertion script"
        status: pass
      - kind: integration
        ref: "uv sync --locked --group maia-inference"
        status: pass
      - kind: unit
        ref: "uv run pytest tests/test_health.py tests/test_guest_auth.py tests/services/test_eval_drain.py -x -q"
        status: pass
    human_judgment: false
  - id: D2
    description: "Frontend lockfile (frontend/package-lock.json) caught up within existing ranges via npm update; onnxruntime-web and the six D-05-guarded ranges untouched"
    verification:
      - kind: other
        ref: "node -e range-check script (ts/vitest/jsdom/@types/node/onnxruntime-web)"
        status: pass
      - kind: integration
        ref: "npm run lint && npm run build && npm test -- --run"
        status: pass
    human_judgment: false
  - id: D3
    description: "Full CLAUDE.md pre-merge gate (ruff format/check, ty x2, pytest -n auto -x, frontend lint/build/test) is green on the caught-up dependency set, with zero unstaged formatting drift"
    verification:
      - kind: integration
        ref: "uv run ruff format --check / ruff check . / ty check app+analysis / pytest -n auto -x / frontend lint+build+test"
        status: pass
    human_judgment: false
  - id: D4
    description: "Renovate actually running on flawchess/flawchess with its Dependency Dashboard issue open (D-01), renovate.json/README badge/dependabot.yml untouched (D-01/D-03)"
    verification:
      - kind: other
        ref: "Dependency Dashboard issue flawchess/flawchess#338 (https://github.com/flawchess/flawchess/issues/338), opened by renovate[bot] on 2026-09-04 within minutes of the Mend settings change"
        status: pass
      - kind: other
        ref: "git diff main -- renovate.json empty; .github/dependabot.yml absent; README.md line 18 badge unchanged"
        status: pass
    human_judgment: true
    rationale: "The GitHub App turned out to be installed already (org-wide, since April 2026); the real blocker was Mend's per-repo Silent mode, which the user switched off in the Mend developer portal. Automerge remains off (D-03)."

duration: ~26 min executor (Tasks 1-3) + user/orchestrator follow-up for Task 4
completed: 2026-09-04
status: complete
---

# Phase 216 Plan 03: Dependency Automation Catch-Up

**Python and frontend lockfiles caught up within existing semver ranges (both D-05 tripwire packages provably untouched), the full CLAUDE.md pre-merge gate is green on the result, and a ruff rule-set pin was added after the version bump revealed ruff 0.16.6 nearly 7x'd its own unconfigured default — and Task 4 revealed the Renovate GitHub App had been installed all along: Mend's per-repo Silent mode was what kept it from ever opening a PR or the Dependency Dashboard. Silent mode is now off and the dashboard is issue #338.**

## Performance

- **Tasks completed:** 4 of 4 (Tasks 1-3 by the executor; Task 4 by the user with orchestrator diagnosis)
- **Files modified:** 12

## Accomplishments

- **Task 1 (Python catch-up):** Proved the scoped-upgrade mechanism on `sqlalchemy` first (thin slice), then regenerated the upgrade candidate list at run time and issued a single `uv lock` call with one `--upgrade-package` flag per safe package. A `--dry-run` re-lock revealed `pydantic-ai-slim` (and its sibling `pydantic-graph`) cascades `anthropic` 0.122.0 -> 1.3.0 transitively through its `anthropic` extra's own floor — dropped both from the upgrade set and re-locked clean. Tripwires verified: `anthropic` still `0.122.0`, `complexipy` still `7.0.1` (both unchanged; every other in-range package updated).
- **ty version bump fallout (0.0.40 -> 0.0.78):** Fixed all 11 newly-surfaced diagnostics — removed 5 stale `ty: ignore` comments the smarter checker no longer needs, `cast()`-narrowed two `dict[str, object]` key reads in `gen_global_percentile_cdf.py`, retyped `prod_selection_bias.py`'s `UserArms` accumulator from `list[int]` to `list[float]` (it stores fractional success credit, a real pre-existing type mismatch the old ty missed), added a non-None assertion + `cast()` before a `sorted()` call in a test, and split a FastAPI-Users duck-typed-mock ignore across its two actual diagnostic lines/rules (`unresolved-attribute` + `invalid-argument-type`).
- **Task 2 (Frontend catch-up):** Captured the `npm outdated` baseline (matching RESEARCH.md's prediction — every D-05 major already excluded from `npm update`'s Wanted column), ran `npm update`, and confirmed `frontend/package.json` is byte-identical (npm rewrote no declared range). `onnxruntime-web` stays exactly `1.27.0`. `npm run lint`, `npm run build` (tsc -b + vite), and `npm test -- --run` all pass (251 files / 3894 tests).
- **Task 3 (Full pre-merge gate):** Ran the six-command CLAUDE.md gate against the caught-up dependency set. Discovered ruff 0.15.15 -> 0.16.6 grew its own **unconfigured default rule set from 62 to 419 rules** (verified empirically via `ruff check --isolated` on both versions) — running `ruff check . --fix` against that expanded default surfaced ~2200 findings across ~380 files, almost entirely from newly-default-enabled plugin categories (bandit, bugbear, flake8-datetimez, flake8-simplify, tryceratops, refurb) that were never part of this project's linting policy. Reverted that over-broad autofix and instead pinned `pyproject.toml`'s `[tool.ruff.lint]` with an explicit `select = ["E4", "E7", "E9", "F"]`, reproducing the pre-bump active rule set (verified: 65 enabled rules with the existing `extend-select`, matching pre-bump behavior). With the pin in place, `ruff format`/`ruff check . --fix` are both clean with zero remaining findings beyond one mechanical whitespace fix in `analysis/README.md`. `ty check` (app + analysis), `pytest -n auto -x` (4502 passed / 19 skipped), and the frontend lint+build+test triad are all green. `git status --porcelain` is clean after the gate.
- **Task 4 (Renovate App):** The install page showed the `flawchess` org already had Renovate ("Configure", installed 5 months ago, access to all repositories, not suspended), so the seed's "app was never installed" diagnosis was wrong. The Mend developer portal job log showed Renovate had been running against the repo every few hours (all DONE) with **Dependency Updates: Silent** set per-repo, the Mend default that suppresses every PR and the dashboard issue. The user switched the repo's Dependencies settings to Silent mode OFF / Automated PRs ON; Mend immediately queued a "settings change" job and the Dependency Dashboard issue #338 appeared on GitHub. `renovate.json` is unchanged, `.github/dependabot.yml` does not exist, the README badge is unchanged, automerge is not enabled anywhere (D-03).

## Task Commits

1. **Task 1: Scoped Python catch-up** - `c32a0776e` (chore) — uv.lock + 8 ty-diagnostic fix files
2. **Task 2: Frontend in-range catch-up** - `811e0fe2e` (chore) — frontend/package-lock.json
3. **Task 3a: Gate-driven formatting fix** - `7cb6eb906` (style) — analysis/README.md
4. **Task 3b: Ruff rule-set pin** - `d4ca602b0` (chore) — pyproject.toml

_Note: Task 3 produced two commits (a mechanical style fix plus a deliberate config-policy decision) per CLAUDE.md's "commit gate-modified files separately with a style/chore prefix" rule; neither is folded into the lockfile commits from Tasks 1-2._

## Files Created/Modified

- `uv.lock` - Scoped in-range upgrade of every safe package (sqlalchemy, alembic, fastapi, pydantic, sentry-sdk, starlette, ty, ruff, and ~40 more); anthropic/complexipy/pydantic-ai-slim/pydantic-graph untouched
- `frontend/package-lock.json` - `npm update` in-range catch-up; package.json untouched
- `pyproject.toml` - Added explicit `ruff.lint.select` pinning the pre-ruff-0.16.6-bump default rule set
- `app/repositories/library_repository.py`, `app/schemas/position_bookmarks.py`, `app/services/insights_llm.py`, `scripts/gen_persona_avatars.py` - Removed now-unused `ty: ignore` comments (ty 0.0.78 narrows these correctly on its own)
- `scripts/gen_global_percentile_cdf.py` - `cast()`-narrowed two `dict[str, object]` sort-key reads instead of relying on ineffective `# type: ignore` comments
- `scripts/two_pawns_up/prod_selection_bias.py` - Retyped `UserArms`'s per-arm list from `list[int]` to `list[float]` (stores fractional success credit); `pooled_rate` casts the trial-count sum back to `int` for its declared return type
- `tests/services/test_eval_drain.py` - Added a non-None assertion + `cast(int, ...)` before sorting `endgame_class` values
- `tests/test_last_activity_middleware.py` - Split a duck-typed-mock ty ignore across its two actual diagnostic lines with both current rule names
- `analysis/README.md` - Mechanical ruff-format whitespace fix in an embedded Python snippet

## Decisions Made

See `key-decisions` in frontmatter. In short: (1) excluded `pydantic-ai-slim`/`pydantic-graph` from the Python upgrade set after proving they cascade the `anthropic` tripwire; (2) fixed all ty-version-bump diagnostics inline since Task 1's acceptance criteria demanded a zero-diagnostic `ty check`; (3) pinned ruff's rule selection to prevent an unrelated ruff default-set expansion from turning a dependency catch-up into an unbounded, out-of-scope lint-fixing exercise.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Scoped Python upgrade cascaded a D-05 tripwire transitively**
- **Found during:** Task 1
- **Issue:** A `uv lock` invocation carrying `--upgrade-package` for every candidate except `anthropic`/`complexipy` still moved `anthropic` 0.122.0 -> 1.3.0, because `pydantic-ai-slim`'s `anthropic` extra requires a newer floor once `pydantic-ai-slim` itself is bumped 2.31.0 -> 2.39.0.
- **Fix:** Reverted `uv.lock` to HEAD (`git checkout -- uv.lock`), removed `pydantic-ai-slim` and `pydantic-graph` from the upgrade-package list, and re-locked (also re-adding `sqlalchemy`, which the revert had undone from the earlier thin-slice step).
- **Files modified:** `uv.lock`
- **Verification:** Tripwire assertion script exits 0, both packages confirmed at pre-task versions; `pydantic-ai-slim`/`pydantic-graph` also confirmed unchanged.
- **Committed in:** `c32a0776e`

**2. [Rule 1 - Bug] ty 0.0.78 surfaced 11 real/stale diagnostics across app/tests/scripts**
- **Found during:** Task 1 (acceptance-criteria gate)
- **Issue:** The ty version bump (part of the same Python catch-up) is stricter: 5 previously-necessary `ty: ignore` comments became unused (unused-ignore-comment warnings), and 6 real type issues surfaced that the old ty version missed, including a genuine `list[int]` vs `list[float]` mistype in a reporting script's accumulator.
- **Fix:** See "Files Created/Modified" above for the per-file fix. All fixes are either removing now-superfluous suppressions or `cast()`/assertion-based narrowing at points where the runtime invariant is already guaranteed by surrounding logic.
- **Files modified:** 8 files (listed above)
- **Verification:** `uv run ty check app/ tests/ scripts/` reports "All checks passed!"; `uv run pytest tests/test_health.py tests/test_guest_auth.py tests/services/test_eval_drain.py -x -q` — 64 passed.
- **Committed in:** `c32a0776e`

### Architectural-Adjacent Decision (Rule 4-caliber, made autonomously per auto-mode)

**3. [Rule 4 - Config policy] Pinned ruff's lint rule selection after the version bump expanded ruff's own default**
- **Found during:** Task 3
- **Issue:** `pyproject.toml`'s `[tool.ruff.lint]` had only `extend-select`, relying implicitly on ruff's own default rule set. Verified empirically (`ruff check --isolated` with zero project config) that ruff 0.15.15 defaults to 62 enabled rules while ruff 0.16.6 defaults to 419 — a ~7x expansion adding entire plugin categories (bandit `S`, bugbear `B`, flake8-datetimez `DTZ`, flake8-simplify `SIM`, tryceratops `TRY`, refurb `FURB`, and more) that this project never opted into. Running the mandated `ruff check . --fix` against that expanded default surfaced ~2200 findings across ~380 files — the majority auto-fixable (import-sort reordering, stale `noqa` removal) but 418 requiring manual judgment per-finding (e.g. `BLE001` blind-except, `DTZ001` naive-datetime), many touching real business logic far outside a "no product behavior change" dependency catch-up's declared boundary.
- **Why this wasn't a blind fix:** Applying `--fix` and hand-fixing the remaining 418 would have turned a scoped dependency-catch-up plan into an unbounded, unreviewed refactor of ~380 files' error handling and datetime usage — squarely the kind of change SEED-161/216-03's scope explicitly excludes ("No product behavior change").
- **Decision:** Added `select = ["E4", "E7", "E9", "F"]` to `[tool.ruff.lint]`, reproducing ruff 0.15.15's own default under 0.16.6 (verified 65 enabled rules with the existing `extend-select`, matching pre-bump behavior exactly). Re-ran the gate: `ruff format`/`ruff check . --fix` clean, zero remaining findings, one incidental whitespace fix already accounted for.
- **Alternatives considered:** (a) Fix all 2200 findings now — rejected as unbounded scope creep with real behavior-change risk. (b) Baseline via `per-file-ignores` like Phase 214's complexity gate — rejected as unworkable at this scale (would require ~380 per-file entries for rules the project never asked for) and doesn't address the root cause (every future ruff bump could add more categories silently). (c) Accept the new stricter defaults going forward and schedule a follow-up phase to work through them deliberately — this is what the pin enables: adopting a new rule category is now an explicit, reviewable `pyproject.toml` diff instead of an automatic side effect of `uv lock --upgrade-package ruff`.
- **Reversibility:** Cheap — removing the `select` line (or adding specific new rule prefixes to `extend-select`) re-exposes any of the newly-available categories at any time; no code was changed to accommodate this decision, only the lint gate's own configured scope.
- **Files modified:** `pyproject.toml`, `analysis/README.md` (incidental)
- **Verification:** `uv run ruff format --check app/ tests/ scripts/ analysis/` -> "467 files already formatted"; `uv run ruff check .` -> "All checks passed!"; full `pytest -n auto -x` and frontend lint/build/test all green afterward (no behavior depends on lint config).
- **Committed in:** `7cb6eb906` (style, README whitespace), `d4ca602b0` (chore, the pin)

**4. [Process note, not a rule] Discarded an over-broad in-progress `ruff --fix` result mid-task**
- **Found during:** Task 3
- **Issue:** Before diagnosing the ruff default-expansion cause above, `ruff check . --fix` had already been run and had modified 380 files in the working tree (uncommitted).
- **Fix:** `git checkout -- .` to discard those uncommitted changes once the root cause was understood, before re-running the gate with the rule-set pin in place. This only affected this task's own not-yet-reviewed, not-yet-committed working-tree state from the same turn — Task 1 and Task 2's commits were already on disk and unaffected.
- **Impact:** None — this was a self-correction of an in-progress mistake, not a rollback of committed or user work.

---

**Total deviations:** 2 auto-fixed (Rules 1 & 3), 1 Rule-4-caliber config decision made autonomously (documented above with full alternatives for review), 1 process note.
**Impact on plan:** No product behavior change anywhere in the diff. The ruff rule-set pin is the one decision worth a maintainer's explicit sign-off — it is fully reversible and does not touch any application code; flagging prominently here and in `## Next Phase Readiness` below.

## Issues Encountered

- `uv sync`/`uv run` commands print a `VIRTUAL_ENV=analysis/.venv does not match the project environment path` warning throughout this session because the shell's `VIRTUAL_ENV` was pre-set to the `analysis/` sub-project's venv. Cosmetic only — every command still targeted the correct `.venv` and all verifications passed. Not fixed (out of scope, pre-existing shell state, no file to change).
- The full `pytest -n auto -x` run surfaced 4 pre-existing `StarletteDeprecationWarning: 'HTTP_422_UNPROCESSABLE_ENTITY' is deprecated` warnings from the fastapi 0.136.3 -> 0.141.1 bump (Task 1). Warnings only, all tests still pass — not fixed here (would mean touching `app/routers/eval_remote.py`'s status-code usage across multiple endpoints, out of scope for a dependency catch-up with no behavior change). Flagged here for a future phase.

## User Setup Required

Done. The only external change was in the Mend developer portal (developer.mend.io, repo flawchess/flawchess, Settings -> Dependencies): Silent mode off, Automated PRs on. If Renovate ever goes quiet again, check that toggle first, not the GitHub App install.

## Next Phase Readiness

- Tasks 1-3 are fully done and committed; the dependency set is caught up within existing ranges and the full gate is green.
- **Task 4 done:** Dependency Dashboard is flawchess/flawchess#338. Expect the first Renovate PRs (the D-05 majors and a grouped minor/patch PR) on the next scheduled window (`before 6am on monday`, Europe/Zurich); review each by hand.
- **Flag for maintainer attention:** the `pyproject.toml` ruff `select` pin (commit `d4ca602b0`) is a policy decision, not a pure mechanical fix — it deliberately freezes the project's lint scope at its pre-2026-09-04 boundary rather than adopting ruff 0.16.6's much larger default. Review the pinned rule list and decide whether/when to deliberately opt into any of the newly-available categories (bandit, bugbear, datetimez, etc.) as their own scoped phase.

## Self-Check: PASSED

- `uv.lock` — FOUND (modified, anthropic 0.122.0 / complexipy 7.0.1 confirmed via tripwire script)
- `frontend/package-lock.json` — FOUND (modified, package.json byte-identical)
- `pyproject.toml` — FOUND (modified, `select = ["E4", "E7", "E9", "F"]` present)
- Commit `c32a0776e` — FOUND in `git log --oneline`
- Commit `811e0fe2e` — FOUND in `git log --oneline`
- Commit `7cb6eb906` — FOUND in `git log --oneline`
- Commit `d4ca602b0` — FOUND in `git log --oneline`
- Task 1 acceptance criteria: re-verified PASS (tripwires, `uv sync --locked`, `ty check` zero diagnostics)
- Task 2 acceptance criteria: re-verified PASS (lockfile changed, ranges intact, onnxruntime-web byte-identical, lint/build/test green)
- Task 3 acceptance criteria: re-verified PASS (all six gate commands + frontend build green, `git status --porcelain` clean, gate-modified files committed separately under style/chore)
- Task 4 acceptance criteria: PASS (dashboard issue #338 recorded, `git diff renovate.json` empty, no dependabot.yml, README badge unchanged, automerge off)
- Plan-level `<verification>`: PASS — tripwires untouched, `uv sync --locked` succeeds, full gate + frontend build green, `renovate.json`/`.github/dependabot.yml`/README badge untouched.

---
*Phase: 216-audit-bugs-and-quick-wins*
*Completed: 2026-09-04*
