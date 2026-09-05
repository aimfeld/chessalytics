---
phase: 218-backend-onnxruntime-parity-spike-python-3-14-chain
plan: 03
subsystem: infra
tags: [release, pre-merge-gate, changelog, squash-merge, python-3.14, onnxruntime]

# Dependency graph
requires:
  - phase: 218-02
    provides: Both native onnxruntime pins at 1.29.0 and the backend on Python 3.14 with both images digest-pinned and built locally
provides:
  - "Full CLAUDE.md pre-merge gate green on the Python 3.14 tree, with the Maia parity and engine test modules observed PASSED (17/17, zero SKIPPED)"
  - "CHANGELOG.md `## [Unreleased]` / `### Changed` bullet for Phase 218"
  - "Phase 218 integrated into `main` as a single squash-merge commit (55e1c0151), pushed; `main` equals `origin/main`"
  - "Release explicitly HELD on `main` by human decision; no PR to `production`, no `bin/deploy.sh` run"
affects: [next-release]

# Actuals (#2632)
actuals:
  tokens: 45000
  tasks: 2
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Formatter churn from a target-version bump is committed alone as `style(...)` before the integration commit, so the squash-merge diff stays readable"

key-files:
  created:
    - .planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-03-SUMMARY.md
  modified:
    - CHANGELOG.md
    - .planning/seeds/SEED-162-major-dependency-backlog.md

key-decisions:
  - "Release checkpoint answered `hold`: the 3.14 bump and onnxruntime 1.29.0 stay on `main`, unreleased, alongside the undeployed Phase 217 work. Rationale recorded by the user at the checkpoint; the deploy is a deliberate deferral, not a failure."
  - "PEP 758 unparenthesized `except A, B:` clauses accepted as the project's formatter output under the 3.14 target rather than pinning ruff's target-version back to 3.13"

patterns-established: []

requirements-completed: []

coverage:
  - id: D1
    description: "Full pre-merge gate green on the 3.14 tree, every command, parity modules observed running"
    verification:
      - kind: other
        ref: "uv run ruff format --check / ruff check . / ty check app tests scripts / ty check analysis / check_function_size.py -> all clean (after style commit d08c522b5)"
        status: pass
      - kind: unit
        ref: "uv run --group maia-inference pytest tests/services/test_maia_parity.py tests/services/test_maia_engine.py -v -> 17 passed, 0 skipped"
        status: pass
      - kind: unit
        ref: "uv run --group maia-inference pytest -n auto -x -> 4506 passed, 19 skipped; frontend npm run lint clean, npm test 3897 passed"
        status: pass
    human_judgment: false
  - id: D2
    description: "Phase on main as one squash-merge, pushed, main == origin/main, current branch main, worker/API Dockerfiles moved together"
    verification:
      - kind: other
        ref: "git rev-list --left-right --count main...origin/main -> 0 0; git branch --show-current -> main; last commit touching Dockerfile.worker also touches Dockerfile"
        status: pass
    human_judgment: false
  - id: D3
    description: "Release to production verified on flawchess.com"
    verification:
      - kind: other
        ref: "NOT RUN. Checkpoint answered `hold`; deploy deferred to a later release."
        status: deferred
    human_judgment: true

# Metrics
duration: 9min
completed: 2026-09-05
status: complete
---

# Phase 218 Plan 03: Gate, changelog, squash-merge, release decision Summary

**The Python 3.14 + onnxruntime 1.29.0 chain passed the full pre-merge gate with the Maia parity tests observed running under 3.14, landed on `main` as one squash-merge (`55e1c0151`, pushed), and the release itself was held on `main` by human decision.**

## Performance

- **Duration:** 9 min (Task 1 executor) plus the checkpoint round-trip
- **Started:** 2026-09-05T08:05:00Z (approx)
- **Completed:** 2026-09-05T08:25:00Z (approx)
- **Tasks:** 2 of 3 (Task 1 auto, Task 2 checkpoint answered `hold`; Task 3 deploy deferred by that answer)
- **Files modified:** 18 (17 reformatted by the style commit, plus CHANGELOG.md) before the squash-merge; SEED-162 after it

## Accomplishments

- Ran every command of the CLAUDE.md pre-merge gate on the 3.14 tree, in order, and resolved the one non-clean output: `ruff format` under the 3.14 target rewrites `except (A, B):` to PEP 758 `except A, B:` in 17 files. Applied and committed alone as `style(218-03)` (`d08c522b5`) so the integration diff stays about the phase.
- Proved the phase's central claim rather than assuming it: `tests/services/test_maia_parity.py` and `tests/services/test_maia_engine.py` ran under Python 3.14.3 with onnxruntime 1.29.0 and reported 17 PASSED, zero SKIPPED. Full backend suite 4506 passed; frontend lint clean and 3897 tests passed.
- Wrote the `## [Unreleased]` changelog bullet under the existing `### Changed` group, `Internal:` prefix, ending `(Phase 218)`; no released section touched.
- Squash-merged the phase branch into `main` as `55e1c0151`, deleted the branch, pushed. `main...origin/main` reads `0 0` and the current branch is `main` (the GSD commit helper did not recreate the phase branch).
- Re-checked success criterion 4 on the merged history: the most recent commit touching `Dockerfile.worker` also touches `Dockerfile`.

## Task Commits

1. **Task 1: Full pre-merge gate, changelog bullet, squash-merge to main** - `d08c522b5` (style), `aa0a65139` (docs, changelog), `55e1c0151` (feat, squash-merge on `main`)
2. **Task 2: Release checkpoint** - no commit; answered `hold`
3. **Task 3: Deploy, forward-port, close SEED-162 cluster 4** - NOT RUN (deferred by the `hold` answer)

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `CHANGELOG.md` - one `Internal:` bullet under `## [Unreleased]` / `### Changed` for Phase 218
- 17 files under `app/`, `scripts/`, `tests/` - PEP 758 except-clause reformat only, no logic change
- `.planning/seeds/SEED-162-major-dependency-backlog.md` - cluster 4 status: merged to `main`, release held

## Decisions Made

- **Release held on `main`** (user decision at the Task 2 checkpoint, 2026-09-05). Phase 218 and the undeployed Phase 217 work stay on `main` for a later release. The interpreter bump remains revertible with a single commit until then.
- PEP 758 formatter output accepted rather than pinning ruff's target back to 3.13.

## Deviations from Plan

None in Task 1. Task 3 did not run because the plan's own checkpoint routed to `hold`; the plan text names this outcome explicitly ("close the phase with the deploy recorded as an explicit deferral").

## Issues Encountered

None.

## User Setup Required

None.

## Deferred: the release itself

**No version of Phase 218 is running on flawchess.com yet.** `origin/production` is still `3c64c0371` (Phase 216, deployed 2026-09-04). When the next release is cut it will carry:

- Phase 218: backend on Python 3.14, onnxruntime 1.29.0, both images re-pinned by digest.
- Phase 217: browser Maia runtime on onnxruntime-web 1.29.0 (one-time engine-asset re-download for returning devices), vitest 5 / jsdom 30, the Google callback StrictMode fix.

Operator follow-up independent of the release: the remote Stockfish worker fleet image is built and deployed manually outside `bin/deploy.sh`, so the fleet stays on its current interpreter until rebuilt from `Dockerfile.worker`.

## Next Phase Readiness

`main` is clean, pushed, and gate-green. Run `/deploy` when ready to ship; SEED-162 cluster 4 closes with the deployed SHA at that point.

---
