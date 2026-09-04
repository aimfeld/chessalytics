---
phase: 215-frontend-god-file-decomposition
plan: 01
subsystem: tooling
tags: [eslint, sonarjs, complexity-gate, lint, frontend]

requires: []
provides:
  - "eslint complexity/max-depth/max-statements enforced at error across frontend/src/**/*.{ts,tsx}"
  - "Phase 215 baseline override region in frontend/eslint.config.js (three blocks: complexity, max-statements, max-depth)"
  - "npm run lint:cognitive report-only sonarjs/cognitive-complexity script"
  - "app-wide before-baselines for all four rules plus cognitive-complexity, for wave-2 plans to prove their own file against"
affects: [215-02, 215-03, 215-04, 215-05, 215-06, 215-07, 215-08]

actuals:
  tokens: 3300
  tasks: 3
  commits: 3

tech-stack:
  added: [eslint-plugin-sonarjs@4.2.0]
  patterns:
    - "ESLint flat-config baseline override region, one block per rule, deleted by the plan that fixes the file (mirrors Phase 214's per-file-ignores backend pattern)"
    - "Report-only sibling eslint config file (eslint.config.sonarjs.mjs) spreading the base config, invoked by its own npm script, never chained into the gating lint run or CI"

key-files:
  created:
    - frontend/eslint.config.sonarjs.mjs
  modified:
    - frontend/eslint.config.js
    - frontend/package.json
    - frontend/package-lock.json
    - docs/dev-tooling.md
    - CLAUDE.md
    - frontend/CLAUDE.md

key-decisions:
  - "complexity/max-depth/max-statements enforced at error (not warn) inside the existing **/*.{ts,tsx} block — npm run lint has no --max-warnings, so warn is decorative"
  - "max-lines-per-function deliberately excluded from the enforced set — it counts the returned JSX tree, which CLAUDE.md's logic-LOC rule explicitly carves out; max-statements is the analog instead"
  - "useBotGame.ts and workerPool.ts get no baseline entry — both measured clean against all three rules today, so a decorative entry would make the region grow instead of shrink"
  - "eslint-plugin-sonarjs wired via a SEPARATE config file (eslint.config.sonarjs.mjs) behind its own npm run lint:cognitive script, not chained into npm run lint or CI — report-only per phase contract"

patterns-established:
  - "Phase 215 baseline override region in eslint.config.js: `complexity`, `max-statements`, `max-depth` off-blocks, each shrinking as wave-2 plans delete their file's entry"

requirements-completed: [SC-0]

coverage:
  - id: D1
    description: "complexity/max-depth/max-statements enforced at error across **/*.{ts,tsx}, npm run lint green with every pre-existing breach baselined"
    requirement: "SC-0"
    verification:
      - kind: other
        ref: "cd frontend && npm run lint"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' src/pages/Analysis.tsx (6 findings)"
        status: pass
    human_judgment: false
  - id: D2
    description: "useBotGame.ts and workerPool.ts are clean against all three enforced rules and carry no baseline entry"
    verification:
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' --rule 'max-depth: [\"error\", 4]' --rule 'max-statements: [\"error\", 100]' src/hooks/useBotGame.ts src/lib/engine/workerPool.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "eslint-plugin-sonarjs installed and wired behind report-only npm run lint:cognitive, outside npm run lint and CI"
    verification:
      - kind: other
        ref: "cd frontend && npm run lint:cognitive (42 sonarjs/cognitive-complexity findings); npm run lint reports none"
        status: pass
      - kind: other
        ref: "cd frontend && npm run knip && npx audit-ci --config audit-ci.jsonc"
        status: pass
    human_judgment: false
  - id: D4
    description: "Frontend gate documented in docs/dev-tooling.md, CLAUDE.md, and frontend/CLAUDE.md"
    verification:
      - kind: other
        ref: "grep -c 'lint:cognitive' docs/dev-tooling.md CLAUDE.md frontend/CLAUDE.md"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-09-03
status: complete
---

# Phase 215 Plan 01: Frontend Complexity Gate Summary

**Three eslint core rules (`complexity`, `max-depth`, `max-statements`) enforced at `error` across `frontend/src/**/*.{ts,tsx}` with every pre-existing breach baselined, plus `eslint-plugin-sonarjs`'s cognitive-complexity metric wired behind a report-only `npm run lint:cognitive` — the measurement infrastructure every later Phase 215 plan proves its file against.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-09-03T18:09Z (approx)
- **Completed:** 2026-09-03T18:32:40Z
- **Tasks:** 3
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- `complexity: ['error', 15]`, `'max-depth': ['error', 4]`, `'max-statements': ['error', 100]` added to `frontend/eslint.config.js`'s existing `**/*.{ts,tsx}` rules block; `npm run lint` stays green because every pre-existing breach is baselined in one new labelled override region.
- The Phase 215 baseline region holds three blocks: a 52-path `complexity: 'off'` array (with `Analysis.tsx`/`Openings.tsx` at the end under a comment naming the plans — 215-06, 215-07 — that delete them), a one-path `max-statements: 'off'` block (`Analysis.tsx`), and a one-path `max-depth: 'off'` block (`reminderSlotState.test.ts`, a test file, out of scope).
- `useBotGame.ts` and `workerPool.ts` carry no baseline entry — both measured clean against all three rules today, confirmed by `npx eslint --no-inline-config --rule ...` returning exit 0.
- `eslint-plugin-sonarjs@4.2.0` installed (audited `[OK]` pre-execution, resolves to `github.com/SonarSource/SonarJS`), wired via `frontend/eslint.config.sonarjs.mjs` (spreads the base config, appends `sonarjs/cognitive-complexity` at error/15) and `npm run lint:cognitive`. Not chained into `npm run lint` or CI; `knip` and `audit-ci` unaffected.
- Frontend gate documented in `docs/dev-tooling.md` (two new Scripts bullets), root `CLAUDE.md` ("Frontend measurement tools:" sub-bullet), and `frontend/CLAUDE.md` (one Code Style & Safety bullet).

## Task Commits

1. **Task 1: Enable complexity/max-depth/max-statements at `error` with a measured baseline, `npm run lint` green** — `3d34a4fe4` (feat)
2. **Task 2: eslint-plugin-sonarjs behind a report-only `npm run lint:cognitive`** — `bfe58fe50` (feat)
3. **Task 3: Document the frontend gate in docs/dev-tooling.md and both CLAUDE.md files** — `dcaf9db68` (docs)

**Plan metadata:** this SUMMARY commit (pending)

## Files Created/Modified

- `frontend/eslint.config.js` — three rules added to the TS/TSX block; new Phase 215 baseline region (3 override blocks)
- `frontend/eslint.config.sonarjs.mjs` (new) — report-only sonarjs config spreading the base config
- `frontend/package.json` — `lint:cognitive` script; `eslint-plugin-sonarjs` devDependency
- `frontend/package-lock.json` — resolved tree for the new devDependency
- `docs/dev-tooling.md` — two new Scripts bullets (frontend complexity rules, `lint:cognitive`)
- `CLAUDE.md` — "Frontend measurement tools:" sub-bullet in the function-size rule
- `frontend/CLAUDE.md` — one Code Style & Safety bullet on the complexity gate

## Baseline Measurements (recorded per plan output spec)

**Reconnaissance command:** `npx eslint --no-inline-config --rule 'complexity: ["warn", 15]' --rule 'max-depth: ["warn", 4]' --rule 'max-statements: ["warn", 100]' --rule 'max-lines-per-function: ["warn", {"max": 200, "skipBlankLines": true, "skipComments": true}]' -f json .` (eslint 10.4.1, measured 2026-09-03), reduced twice:

**All linted paths** (includes 6 vendored `frontend/public/` bundles):

| Rule | Breaches | Files |
|---|---|---|
| `complexity > 15` | 117 | 58 |
| `max-depth > 4` | 27 | 4 |
| `max-statements > 100` | 4 | 3 |
| `max-lines-per-function > 200` | 67 | 63 |

**`.ts`/`.tsx` only** (what the enforced rules actually cover):

| Rule | Breaches | Files |
|---|---|---|
| `complexity > 15` | 69 | 52 |
| `max-depth > 4` | 6 | 1 (`src/lib/__tests__/reminderSlotState.test.ts`) |
| `max-statements > 100` | 1 | 1 (`src/pages/Analysis.tsx`) |
| `max-lines-per-function > 200` | 66 | 62 |

All four numbers reproduce the planner's 2026-09-03 measurements exactly.

**Cognitive complexity (`npm run lint:cognitive`, sonarjs default report):**

- App-wide: **42 breaches / 35 files**.
- Per in-scope file: `Analysis.tsx` **4** (lines 549, 1640, 1782, 2390) — matches planner's prediction exactly. `useBotGame.ts` **0**. `workerPool.ts` **1** (line 896, `handleLine`) — matches exactly. `Openings.tsx` **1** (line 114) — matches exactly.

**`react-hooks/*` warning baseline** (measured with `--no-inline-config` so disabled instances are counted; with inline config honored the count is 0 — every instance has a matching disable comment today): `react-hooks/exhaustive-deps` **27**, `react-hooks/refs` **3**. Plans 215-02..215-08 must leave these two counts unchanged (fixing any of the 28 pre-existing warnings is explicitly out of scope per the phase contract — a dependency-array change re-fires an effect, which is a behavior change).

## Decisions Made

- Enforced at `error`, not `warn` — `npm run lint` has no `--max-warnings` flag, so a `warn`-severity rule would never fail CI.
- `max-lines-per-function` NOT added to the enforced set (counts the JSX return tree, which CLAUDE.md's logic-LOC rule excludes); it stays available for ad hoc reconnaissance.
- `useBotGame.ts`/`workerPool.ts` deliberately absent from the baseline region — adding a no-op entry for a clean file would make the region grow, contradicting its "only ever shrinks" contract.
- `eslint-plugin-sonarjs` wired via a fully separate config file and script rather than a second block in the primary config, so it can never accidentally leak into the gating `npm run lint` run.

## Deviations from Plan

None — plan executed exactly as written. All measured numbers matched the planner's 2026-09-03 predictions.

## Issues Encountered

- **Pre-existing test-isolation flake in `src/pages/__tests__/Train.guestGate.test.tsx`**, unrelated to this plan's scope (no `frontend/src/` file was touched — this plan is lint-config/docs only). 2 of 6 tests in that file fail when the full suite runs (`npm test -- --run`), reproduced twice, but the same file passes 6/6 in isolation. Logged to `.planning/phases/215-frontend-god-file-decomposition/deferred-items.md` per the deviation-rules scope boundary (pre-existing failures unrelated to the current task are out of scope, not auto-fixed). Does not affect this plan's own acceptance criteria (`npm run lint`, `npm run build`, `npm run knip` are all green; the flake is orthogonal to lint config).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

The measurement infrastructure is live and proven: the CLI-override proof command (`npx eslint --no-inline-config --rule 'complexity: ["error", 15]' <path>` defeats the baseline region) works exactly as specified, and every wave-2 plan (215-02..215-07) can now prove its own file's improvement with a number instead of an eyeball. `useBotGame.ts` and `workerPool.ts` prove their improvement via `max-lines-per-function` (reconnaissance rule), not via a baseline-region deletion, since neither carries an entry.

No blockers for 215-02 onward.

---
*Phase: 215-frontend-god-file-decomposition*
*Completed: 2026-09-03*

## Self-Check: PASSED

- FOUND: `frontend/eslint.config.sonarjs.mjs`
- FOUND: `.planning/phases/215-frontend-god-file-decomposition/215-01-SUMMARY.md`
- FOUND commit `3d34a4fe4` (Task 1)
- FOUND commit `bfe58fe50` (Task 2)
- FOUND commit `dcaf9db68` (Task 3)
