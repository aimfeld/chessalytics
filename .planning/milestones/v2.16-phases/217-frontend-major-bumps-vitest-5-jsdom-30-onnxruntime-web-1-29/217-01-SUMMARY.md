---
phase: 217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29
plan: 01
subsystem: testing
tags: [vitest, jsdom, undici, npm, dependency-bump, frontend-tooling]

# Dependency graph
requires: []
provides:
  - "vitest/@vitest-coverage-v8/@vitest-ui bumped 4.1.7 -> 5.0.0"
  - "jsdom bumped 29.1.1 -> 30.0.1"
  - "overrides.undici deleted from frontend/package.json (jsdom 30 resolves undici@8.10.2 natively)"
  - "cluster 1 squash-merged to main as a single revertable commit, full pre-merge gate green"
affects: ["217-02 (cluster 2 executor branches from this new main)"]

actuals:
  tokens: 7108
  tasks: 3
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Deletion (not raise) is the correct undici-override resolution once the parent (jsdom 30) declares a strictly newer native range than the override floor and no live advisory targets the transitive dep."

key-files:
  created: []
  modified:
    - frontend/package.json
    - frontend/package-lock.json

key-decisions:
  - "Deleted overrides.undici entirely rather than raising it to ^8.9.0 (D-02) — jsdom 30 resolves undici@8.10.2 on its own declared range, while shadcn@4.21.0 and @dotenvx/dotenvx@1.75.1 stay on 7.29.1 without being forced across an undeclared major."
  - "No D-05 pin-back was needed: vitest@5.0.0, despite being one day old at research time, passed the full 251-file/3894-test suite clean on the first run with no clearMocks-exposed test-isolation gaps."
  - "No CHANGELOG.md entry added — test tooling only, no user-observable change, matching the bc737e2fb/d1693e05f Tier A dependency-chore precedent."
  - "Task 2 required zero code changes: the suite was already green under vitest 5's new clearMocks:true default, so there is no separate Task 2 commit (Task 1's commit already satisfies both tasks' file-level deliverables)."

patterns-established:
  - "Delete-not-raise resolution for an overrides floor once the natural parent range clears it (see key-decisions)."

requirements-completed: []

coverage:
  - id: D1
    description: "vitest, @vitest/coverage-v8, @vitest/ui 5.x and jsdom 30.x resolve; full frontend suite green with no per-file timeout literal added and shared timeout constants unchanged"
    verification:
      - kind: unit
        ref: "cd frontend && npm test -- --run (251 test files, 3894 tests)"
        status: pass
      - kind: other
        ref: "grep -rn '}, [0-9]{4,})' frontend/src --include=*.test.ts --include=*.test.tsx | wc -l -> 8 (baseline unchanged)"
        status: pass
    human_judgment: false
  - id: D2
    description: "overrides.undici deleted from frontend/package.json; npm audit reports no undici advisory"
    verification:
      - kind: other
        ref: "grep -c '\"undici\"' frontend/package.json -> 0; npm audit --json filter -> 'undici: no advisory'"
        status: pass
    human_judgment: false
  - id: D3
    description: "Full CLAUDE.md pre-merge gate plus npm run build green immediately before cluster 1's squash-merge to main"
    verification:
      - kind: integration
        ref: "ruff format/check, ty (app+analysis), check_function_size.py, pytest -n auto -x (4506 passed/19 skipped), npm run lint, npm test -- --run, npm run build, npx audit-ci --config audit-ci.jsonc"
        status: pass
    human_judgment: false

duration: ~20min
completed: 2026-09-05
status: complete
---

# Phase 217 Plan 01: Vitest 5 + jsdom 30 Bump Summary

**vitest/@vitest-coverage-v8/@vitest-ui 4.x->5.x and jsdom 29.x->30.x bumped together with the undici override deleted, full suite green on first run, squash-merged to `main`**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-05T03:00:00Z (approx.)
- **Completed:** 2026-09-05T03:15:13Z
- **Tasks:** 3 completed
- **Files modified:** 2 (`frontend/package.json`, `frontend/package-lock.json`)

## Accomplishments
- `vitest`, `@vitest/coverage-v8`, `@vitest/ui` moved from `^4.1.7` to `^5.0.0` and `jsdom` from `^29.1.1` to `^30.0.1`, all four in one commit per D-01.
- `overrides.undici` deleted from `frontend/package.json` — jsdom 30 now resolves `undici@8.10.2` on its own declared `^8.9.0` range naturally; `shadcn`/`@dotenvx` stay on `undici@7.29.1` untouched. `npm audit` reports zero undici advisories.
- Full frontend suite (251 test files, 3894 tests) passed clean on the very first run under vitest 5's new `clearMocks: true` default — no test-isolation gaps surfaced, no test file edits needed.
- Registry identity re-verified for both bumped packages (`vitest@5.0.0` -> `github.com/vitest-dev/vitest`, `jsdom@30.0.1` -> `github.com/jsdom/jsdom`) per the plan's supply-chain check (T-217-SC).
- Full CLAUDE.md pre-merge gate (backend + frontend) plus `npm run build` and `npx audit-ci` all green immediately before the squash-merge, per D-10.
- Cluster 1 squash-merged locally into `main` as commit `6ca0f8ecd`; the phase branch was force-deleted afterward (expected for a squash-merge — git never marks the source branch "fully merged" after `--squash`).

## Task Commits

1. **Task 1: Bump the four packages together and delete the undici override** - `6c890e622` (chore) — on the (now-deleted) phase branch
2. **Task 2: Run the full suite under vitest 5 / jsdom 30 and triage what clearMocks exposes** - no separate commit; the suite was already green with zero code changes required, so Task 1's commit stands for both
3. **Task 3: Full pre-merge gate, then cluster 1's own squash-merge to main** - `6ca0f8ecd` (chore, squash-merge onto `main`, includes the phase-registration/planning docs that had accumulated on the phase branch alongside the dependency bump)

## Files Created/Modified
- `frontend/package.json` - devDependencies bumped (`vitest`, `@vitest/coverage-v8`, `@vitest/ui` -> `^5.0.0`, `jsdom` -> `^30.0.1`); `overrides.undici` entry removed
- `frontend/package-lock.json` - regenerated by `npm install`, not hand-edited

## Decisions Made
- **undici override: deleted, not raised.** jsdom 30 declares `undici: ^8.9.0` natively (strictly newer than the deleted `^7.29.0` floor); `shadcn@4.21.0` and `@dotenvx/dotenvx@1.75.1` still declare `^7.x` and would have been forced across an undeclared major had the override been raised instead. Post-install `npm ls undici` confirms jsdom resolves `8.10.2` while shadcn/dotenvx stay on `7.29.1`; `npm audit` shows zero live undici advisories either way.
- **No D-05 pin-back invoked.** vitest 5.0.0 (published one day before research) passed the entire 251-file/3894-test suite unmodified on the first run — no fresh-release regression materialized.
- **No CHANGELOG.md entry** — dev-tooling-only change, consistent with the `bc737e2fb`/`d1693e05f` precedent that Tier A dependency chores with zero user-observable effect don't get a changelog line. Cluster 2 (217-02) will add one since it has a real user-visible cost (device UAT).
- `frontend/vite.config.ts` and `frontend/src/vitest.setup.ts` are byte-identical to their pre-task state — verified via `git diff --stat`, confirming D-03 (shared timeout config is the only timeout source, untouched).
- Noted per the plan (no action taken): `@vitest/ui@5` now requires token-based auth for the `/__vitest__/` URL; nothing in this repo's scripts or CI passes `--ui`, so this is a local-dev-only behavior change with zero blast radius here.

## Deviations from Plan

None - plan executed exactly as written. Task 2 produced zero diffs (the suite was already green), which the plan explicitly anticipated as a possible outcome ("Triage every failure on its merits" — there were none to triage).

## Issues Encountered
None. `npm install` resolved cleanly with no peer-dependency conflicts; the full pre-merge gate (backend + frontend) passed on the first attempt with no autofixes needed from `ruff --fix` or ESLint.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `main` is now at `6ca0f8ecd`, a single clean squash commit carrying cluster 1's dependency bump (plus the phase's accumulated planning docs). `git revert` + `npm install` fully restores the previous toolchain if a regression surfaces later.
- The phase branch `gsd/phase-217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29` was deleted per D-09/D-10 bisectability — wave 2's executor will get a fresh branch cut from this new `main`, which already contains the `217-02-PLAN.md` file from the original planning session.
- CI's resolved Node version for this run was not separately observed (this plan ran the gate entirely locally, not via a CI run) — local Node is `v24.19.0`, comfortably over jsdom 30's `^24.15.0` floor. Per Pitfall 4, the next CI run's `actions/setup-node` log line should be spot-checked opportunistically, but no code change is needed unless it's actually under-floor.
- Cluster 2 (`217-02-PLAN.md`, onnxruntime-web 1.29.0 + vendored Maia runtime re-vendor + HUMAN-UAT) is unblocked and ready to execute as wave 2.

---
*Phase: 217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29*
*Completed: 2026-09-05*

## Self-Check: PASSED

- FOUND: `.planning/phases/217-.../217-01-SUMMARY.md`
- FOUND: `6ca0f8ecd` (squash-merge commit on `main`, verified via `git log --oneline --all`)
- `6c890e622` (Task 1's commit on the now-deleted phase branch) is not reachable via `git log --all` — expected: the phase branch was force-deleted after squash-merging, which is the designed outcome of `git merge --squash` (the source branch is never "fully merged" in git's ancestry sense). The commit object itself still exists, confirmed via `git cat-file -t 6c890e622` -> `commit` and present in the reflog (`HEAD@{2}`); its full content is captured verbatim inside squash commit `6ca0f8ecd` on `main`.
- `frontend/package.json` confirmed on disk: `"vitest": "^5.0.0"`, `"jsdom": "^30.0.1"`, zero `"undici"` matches.
