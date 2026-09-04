---
phase: 215-frontend-god-file-decomposition
plan: 02
subsystem: engine
tags: [refactor, complexity, closure-factory, worker-pool, stockfish, mutation-testing]

requires:
  - phase: 215-frontend-god-file-decomposition (plan 01)
    provides: "eslint complexity/max-depth/max-statements enforced at error; measurement infrastructure and CLI-override proof command"
provides:
  - "createWorkerPool() reduced from 418 to 99 counted lines, over four named stage modules (workerPoolState.ts, workerPoolWatchdog.ts, workerPoolDispatch.ts, workerPoolLifecycle.ts)"
  - "PoolState/PoolOps cross-stage seam pattern for closure-factory extractions (state object + dispatch-table-of-functions, late-bound to break the cyclic call graph)"
  - "Three two-way mutation proofs demonstrating the 109-test oracle genuinely exercises the extracted stage modules"
affects: [215-03, 215-04, 215-05, 215-06, 215-07, 215-08]

actuals:
  tokens: 24604
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "PoolState (explicit state object, twelve fields) + PoolOps (twelve-field cross-stage dispatch table) — closure-factory extraction seam for a mutually-recursive call graph, matching Phase 214's eval_apply.py backend precedent"
    - "Local same-name wrapper functions in the factory (e.g. `function clearSlotWatchdog(slot) { wdClearSlotWatchdog(state, ops, slot); }`) preserve every pre-existing call-site expression verbatim across the split, so the diff is additive at call sites and the factory body shrinks without a mechanical rename pass"
    - "A pure, stateless helper needed by two stages (noLiveSlotRemains) is promoted to a plain top-level exported function taking PoolState directly, not routed through PoolOps — avoids growing the dispatch table for a function with no side effects to coordinate, and avoids duplicating the same boolean expression in two sibling files"

key-files:
  created:
    - frontend/src/lib/engine/workerPoolState.ts
    - frontend/src/lib/engine/workerPoolWatchdog.ts
    - frontend/src/lib/engine/workerPoolDispatch.ts
    - frontend/src/lib/engine/workerPoolLifecycle.ts
  modified:
    - frontend/src/lib/engine/workerPool.ts

key-decisions:
  - "noLiveSlotRemains promoted to a plain top-level export of workerPool.ts (task 2), taking PoolState directly rather than (state, ops) — it is a pure predicate needed identically by grade() (dispatch stage) and replaceDeadSlot() (lifecycle stage); routing it through PoolOps would have grown the table for zero side effects to coordinate, and duplicating the boolean expression in two sibling files would add drift risk. workerPoolLifecycle.ts re-exports it (not redefines it) to keep its own public surface complete."
  - "drainPending's PoolOps-convention `ops` parameter was dropped (single-param `drainPending(state)`) after `@typescript-eslint/no-unused-vars` flagged the trailing unused `_ops` — ESLint's default `args: 'after-used'` setting only exempts unused params that precede a used one, not a trailing unused param, so an underscore prefix alone (which satisfies TS's own noUnusedParameters) was insufficient here."
  - "sideToMove promoted to a top-level export (task 2) alongside noLiveSlotRemains, so workerPoolDispatch.ts's handleLine (which needs it for white-POV sign flipping) can import it without duplicating a one-line FEN parse."

requirements-completed: [SC-1, SC-2, SC-3]

coverage:
  - id: D1
    description: "createWorkerPool() reduced from 418 to at most 200 counted lines (99 actual) over four named stage modules; the returned WorkerPool object literal and interface are byte-identical to pre-phase-215"
    requirement: "SC-1"
    verification:
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'max-lines-per-function: [\"error\", {\"max\": 200, \"skipBlankLines\": true, \"skipComments\": true}]' src/lib/engine/workerPool*.ts (exit 0, createWorkerPool measured at 99 lines)"
        status: pass
      - kind: other
        ref: "diff of the WorkerPool interface block and the createWorkerPool return-object literal against the pre-phase-215 file (git show 3dd1c60b8:...) — both byte-identical"
        status: pass
    human_judgment: false
  - id: D2
    description: "The 109-test workerPool.test.ts oracle and the four vi.mock('@/lib/engine/workerPool') consumer suites (useBotGame, useFlawChessEngine, useGemSweep, Analysis) all pass unchanged; no mock factory edited; test diff is additions-only (zero)"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/lib/engine/__tests__/workerPool.test.ts src/hooks/__tests__/useBotGame.test.ts src/hooks/__tests__/useFlawChessEngine.test.ts src/hooks/__tests__/useGemSweep.test.ts src/pages/__tests__/Analysis.test.tsx (310/310 passed)"
        status: pass
      - kind: other
        ref: "git diff -- src/hooks/__tests__/ src/pages/__tests__/ | grep -c \"vi.mock('@/lib/engine/workerPool'\" (0)"
        status: pass
    human_judgment: false
  - id: D3
    description: "No data-testid/data-umami-event attributes added or removed (0/0, unchanged); no TypeScript or lint suppression comment added; no baseline entry added to frontend/eslint.config.js"
    requirement: "SC-3"
    verification:
      - kind: other
        ref: "cd frontend && grep -o 'data-testid=\"[^\"]*\"' src/lib/engine/workerPool*.ts | wc -l (0); git diff -- src/lib/engine/ | grep -cE '^\\+.*@ts-(ignore|expect-error)' (0); grep -v '^\\s*//' eslint.config.js | grep -c 'workerPool' (0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Three two-way mutation proofs (one function per new stage module) show the 109-test oracle genuinely exercises fireWatchdog, handleLine and replaceDeadSlot rather than merely importing them"
    verification:
      - kind: unit
        ref: "workerPool.test.ts, mutated fireWatchdog to an immediate return: 10/109 failed, restored to 109/109 on revert"
        status: pass
      - kind: unit
        ref: "workerPool.test.ts, mutated handleLine to an immediate return: 64/109 failed, restored to 109/109 on revert"
        status: pass
      - kind: unit
        ref: "workerPool.test.ts, mutated replaceDeadSlot to an immediate return: 5/109 failed, restored to 109/109 on revert"
        status: pass
    human_judgment: false

duration: 60min
completed: 2026-09-03
status: complete
---

# Phase 215 Plan 02: workerPool.ts Closure-Factory Decomposition Summary

**`createWorkerPool()` split from a 418-line closure factory into a 99-line state-plus-wiring function over four sibling stage modules (`workerPoolState.ts`, `workerPoolWatchdog.ts`, `workerPoolDispatch.ts`, `workerPoolLifecycle.ts`), with the 109-test worker-protocol oracle and four `vi.mock` consumer suites proving the split byte-for-byte behavior-preserving, backed by three two-way mutation proofs.**

## Performance

- **Duration:** ~60 min
- **Started:** 2026-09-03T18:35Z (approx)
- **Completed:** 2026-09-03T19:32:15Z
- **Tasks:** 3
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments

- `workerPoolState.ts` created: `PoolState` (the twelve mutable bindings `createWorkerPool()` used to close over, doc comments moved verbatim) and `PoolOps` (a twelve-field cross-stage dispatch table, documented as intentionally exceeding the "context object with <3 fields" carve-out because the real call graph between stages is cyclic).
- `workerPoolWatchdog.ts` created: the seven watchdog functions (`clearSlotWatchdog`, `rearmGradingWatchdog`, `fireWatchdog`, `armStopWatchdog`, `fireStopWatchdog`, `armInitWatchdog`, `fireInitWatchdog`) moved verbatim, each taking `(state, ops, ...originalArgs)`.
- `workerPoolDispatch.ts` created: `sendGo`, `dispatchNext`, `handleLine` (the UCI wire-protocol parser — highest-risk function in the phase, moved with identical branch order/comparisons/early returns) and the public `grade()` entry point.
- `workerPoolLifecycle.ts` created: `replaceDeadSlot`, `drainPending`, `createSlot`, `runSpawnConstructionLoop`, `ensureSpawned`, `stopAll`, `terminate`, `warm` — the spawn/respawn/death machinery and the three public teardown/prewarm entry points.
- `workerPool.ts`'s `createWorkerPool()` now holds only: the `state` object literal, `markPoolReady`/`markPoolFailed`/`whenReady` (kept co-located with the readiness contract per the plan), three same-signature local wrappers (`stopAll`/`terminate`/`warm`, preserving the return object's shorthand), and the fully-wired `ops` dispatch table — 99 counted lines, well under the 200-line target.
- Three two-way mutation proofs (one per new stage module) confirm the split is genuinely guarded, not merely present — see Mutation Proofs below.
- `noLiveSlotRemains` and `sideToMove` promoted from private closure/module functions to plain top-level exports of `workerPool.ts`, letting the dispatch stage import them directly instead of routing a pure, stateless helper through `PoolOps` or duplicating it.

## Task Commits

1. **Task 1: PoolState/PoolOps plus the watchdog stage, end to end through the 109-test oracle** — `426974d91` (feat)
2. **Task 2: Extract the dispatch stage and the public `grade` entry point** — `b38646f7f` (feat)
3. **Task 3: Extract the lifecycle stage, hit the 200-line target, and prove the seams with a two-way mutation test** — `0c156f1ec` (feat)

**Plan metadata:** this SUMMARY commit (pending)

## Files Created/Modified

- `frontend/src/lib/engine/workerPoolState.ts` (new) — `PoolState`/`PoolOps` interfaces
- `frontend/src/lib/engine/workerPoolWatchdog.ts` (new) — the seven watchdog fault-detection functions
- `frontend/src/lib/engine/workerPoolDispatch.ts` (new) — dispatch stage and public `grade()`
- `frontend/src/lib/engine/workerPoolLifecycle.ts` (new) — spawn/respawn/death and teardown/prewarm
- `frontend/src/lib/engine/workerPool.ts` — `createWorkerPool()` reduced to state + wiring; `enqueue`/`dequeueHighestPriority`/`isLowPowerDevice`/`computePoolSize`/`createGradeCache`/all 15 exported constants/all exported types unchanged; `sideToMove`/`noLiveSlotRemains` newly exported (were private)

## Before/After Measurements

**`max-lines-per-function` on `createWorkerPool`** (`npx eslint --no-inline-config --rule 'max-lines-per-function: ["warn"/"error", {"max": N, "skipBlankLines": true, "skipComments": true}]'`):

| Point | Lines |
|---|---|
| Before (pre-phase-215 baseline, confirmed 2026-09-03) | 418 |
| After Task 1 (state + watchdog stage extracted) | 361 |
| After Task 2 (dispatch stage + `grade()` extracted) | 243 |
| After Task 3 (lifecycle stage extracted) — **final** | **99** |

No function across the five `workerPool*.ts` files exceeds 100 counted lines (checked with the rule set to `max: 100`) — no function needed a 100-200-line justification note.

**`npm run lint:cognitive` (Sonar cognitive complexity) for `src/lib/engine/workerPool*`:**

| Point | Breaches |
|---|---|
| Before (215-01 baseline) | 1 (`handleLine`, cognitive 16, at `workerPool.ts:896`) |
| After this plan | 1 (`handleLine`, cognitive 16, now at `workerPoolDispatch.ts:80`) |

Unchanged count and unchanged complexity value — `handleLine` moved verbatim per the plan's explicit instruction ("same branch order, same string comparisons, same early returns"); this was a relocation, not a rewrite, so `lint:cognitive` (report-only, not gated) sees the identical function.

**Sentry capture-site count** (`grep -c 'Sentry.captureException'`):

| Location | Count |
|---|---|
| `workerPool.ts` (pre-split) | 6 |
| `workerPool.ts` (post-split) | 0 |
| `workerPoolWatchdog.ts` | 3 |
| `workerPoolLifecycle.ts` | 3 |
| **Total (post-split)** | **6** |

Every capture site moved with its surrounding try/catch, unchanged; the sum is identical to the pre-split count.

## Mutation Proofs (Task 3, step 3)

One function per new stage module, temporarily replaced with an immediate `return;`, `workerPool.test.ts` re-run, body restored, suite re-confirmed green.

| Function (module) | Mutated result | Failing tests | Restored result |
|---|---|---|---|
| `fireWatchdog` (`workerPoolWatchdog.ts`) | 99 passed, 10 failed | All 10 in `createWorkerPool: watchdog (D-06)` — `settles empty once GRADING_WATCHDOG_TIMEOUT_MS elapses...`, `posts stop to the worker...`, `a slot killed by the watchdog is REPLACED...`, `when replacements never boot...`, `settles empty exactly at GRADING_WATCHDOG_TIMEOUT_MS...`, and 5 `FLAWCHESS-9G:` suspend/liveness re-arm tests | 109/109 passed |
| `handleLine` (`workerPoolDispatch.ts`) | 45 passed, 64 failed | The overwhelming majority of `grade() dispatch`, `gradingDepth parameter plumbing`, `watchdog (D-06)`, `grade cache`, `grade() on a fully dead pool`, and `lifecycle` describe blocks — this is the UCI wire-protocol parser and the highest-risk function in the phase, and the failure count reflects that essentially everything routes through it | 109/109 passed |
| `replaceDeadSlot` (`workerPoolLifecycle.ts`) | 104 passed, 5 failed | `a slot killed by the watchdog is REPLACED...`, `when replacements never boot...`, `WR-04: once every slot has failed via onerror, a still-pending request drains...`, `marks stockfish-wasm failed and rejects a pending whenReady() once every slot has died...`, `a slot that dies is replaced with a worker built from the SAME shared URL...` | 109/109 passed |

None of the three mutations left the suite green, so no test addition to `workerPool.test.ts` was required (per the plan's step-3 instruction, addition was conditional on an unguarded mutation).

**Operational note (mutation-test execution):** the `handleLine` and (initial attempt at) full-function mutations run under REAL timers for most `describe` blocks (only the `watchdog (D-06)` block sets up `vi.useFakeTimers()`), so a naive full-suite mutation run against the default 5000ms `testTimeout` took over two minutes and was killed; re-running with an explicit `--testTimeout=1000`/`--testTimeout=2000` override made each hanging test fail fast instead of waiting out the real-timer default, without changing which tests failed.

## Decisions Made

- `noLiveSlotRemains` promoted to a plain top-level export of `workerPool.ts` (Task 2) rather than moved into a `(state, ops)`-shaped stage function — it's a pure, stateless `PoolState` predicate needed identically by `grade()` (dispatch) and `replaceDeadSlot()` (lifecycle), and neither routing it through `PoolOps` (which would grow the table for zero side effects) nor duplicating the boolean expression across two sibling files was preferable. `workerPoolLifecycle.ts` re-exports it (not a redefinition) to keep the module's public surface matching the plan's seam-map framing.
- `sideToMove` similarly promoted to a top-level export so `workerPoolDispatch.ts`'s `handleLine` can import it directly.
- `drainPending`'s signature dropped the `ops` parameter (deviating from the plan's literal "same `(state, ops, ...)` signature convention" for this one function) after `@typescript-eslint/no-unused-vars` flagged the unused trailing `_ops` — ESLint's `args: 'after-used'` default only exempts an unused parameter that precedes a used one, not a trailing one, so the underscore-prefix convention that worked for the watchdog stage's leading unused params (`clearSlotWatchdog(_state, _ops, slot)`) didn't apply here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `drainPending`'s unused trailing `ops` parameter triggered a lint error**
- **Found during:** Task 3 (post-extraction verification, `max-lines-per-function` proof command)
- **Issue:** `drainPending(state: PoolState, _ops: PoolOps)` — matching the plan's uniform `(state, ops, ...)` signature convention — tripped `@typescript-eslint/no-unused-vars` because ESLint's default `args: 'after-used'` setting only ignores unused parameters that occur before the last USED parameter, not a trailing unused one (unlike TypeScript's own `noUnusedParameters`, which the underscore-prefix convention used for the watchdog stage's `_state`/`_ops` leading params already satisfied).
- **Fix:** Dropped the unused `ops` parameter entirely — `drainPending(state: PoolState): void` — and updated its two internal call sites (`workerPoolLifecycle.ts`) plus the `ops.drainPending` wiring in `workerPool.ts` to match.
- **Files modified:** `frontend/src/lib/engine/workerPoolLifecycle.ts`, `frontend/src/lib/engine/workerPool.ts`
- **Verification:** `npm run lint` clean; `npx vitest run src/lib/engine/__tests__/workerPool.test.ts` still 109/109.
- **Committed in:** `0c156f1ec` (Task 3 commit)

**2. [Rule 3 - Blocking] `noLiveSlotRemains` needed by both the dispatch and lifecycle stages, but `PoolOps` is a fixed 12-field interface**
- **Found during:** Task 2 (extracting `grade()`, which calls `noLiveSlotRemains()`)
- **Issue:** `noLiveSlotRemains` (a pure predicate over `state.slots`) is called by `grade()` (moving to `workerPoolDispatch.ts` in Task 2) and by `replaceDeadSlot()` (staying inline until Task 3, then moving to `workerPoolLifecycle.ts`). It was originally a closure-captured inner function of `createWorkerPool()`, so it could not be imported into a sibling module without either becoming a `PoolOps` field, being duplicated in two sibling files, or being promoted to a plain top-level export.
- **Fix:** Promoted `noLiveSlotRemains` (and, for the same reason, `sideToMove`) to plain top-level exports of `workerPool.ts`, taking `PoolState` directly (matching the existing `enqueue`/`dequeueHighestPriority` convention of plain functions over explicit parameters rather than closure state). `workerPoolLifecycle.ts` re-exports `noLiveSlotRemains` (not a redefinition) to keep its own public surface complete per the plan's seam map, which lists it among the nine lifecycle-stage functions.
- **Files modified:** `frontend/src/lib/engine/workerPool.ts` (Task 2), `frontend/src/lib/engine/workerPoolLifecycle.ts` (Task 3, re-export only)
- **Verification:** `npx vitest run` 109/109 at every subsequent checkpoint; `npm run knip` clean (no dead-export false positive); `npm run build` clean (no circular-import type error).
- **Committed in:** `b38646f7f` (Task 2 commit, definition) and `0c156f1ec` (Task 3 commit, re-export)

---

**Total deviations:** 2 auto-fixed (1 lint-driven signature fix, 1 architectural seam adjustment for a cross-stage pure helper)
**Impact on plan:** Both deviations are internal implementation details invisible to any consumer of `@/lib/engine/workerPool` — the public `WorkerPool` interface, the four other public exports the four `vi.mock` factories depend on, and the 109-test oracle are all unaffected. No scope creep.

## Issues Encountered

- **Mutation-test execution time.** The `handleLine` two-way mutation initially hung well past 2 minutes on the default `testTimeout` because most `describe` blocks in `workerPool.test.ts` use real timers (only the `watchdog (D-06)` block sets up `vi.useFakeTimers()`), and a mutated `handleLine` means `bestmove`/`readyok` are never processed, so every real-timer-based `await pool.grade(...)` in the suite hangs until timeout. Resolved by re-running with an explicit `--testTimeout=1000`/`--testTimeout=2000` CLI override so each hanging test fails fast; this only changes how quickly a doomed test reports failure, not which tests fail. Not a code issue — purely an execution-harness note for anyone repeating this mutation-test technique on this file.
- **Pre-existing test-isolation flake in `src/pages/__tests__/Train.guestGate.test.tsx`** (documented in 215-01-SUMMARY.md, re-confirmed here): 2 of 6 tests fail when the full `npm test -- --run` suite runs, but the same file passes 6/6 in isolation (re-verified this session). Unrelated to this plan — no file under `src/pages/` or `src/hooks/__tests__/Train*` was touched. `npm run lint`, `npm run build`, `npm run knip`, and the targeted `workerPool.test.ts` + four mock-consumer suites are all fully green; only the full-suite `npm test -- --run` run shows this pre-existing, orthogonal flake.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

`workerPool.ts` is done for Phase 215: `createWorkerPool()` sits at 99 counted lines (well under the 200 target), no complexity/max-depth/max-statements breach remains across the five files, and the file carries no baseline entry in `frontend/eslint.config.js`'s Phase 215 override region (it never needed one — see 215-01-SUMMARY.md). The `PoolState`/`PoolOps` seam pattern (explicit state object + a fixed-shape cross-stage dispatch table, late-bound to break a cyclic call graph) is available as a reusable precedent for any later Phase 215 plan that hits a similar closure-factory-with-mutually-recursive-stages shape, though none of the remaining wave-2 targets (`useBotGame.ts`, `Analysis.tsx`, `Openings.tsx`) are closure factories — they are React hooks/components, so this exact pattern likely doesn't transfer directly; the "local same-name wrapper function preserves call-site text" technique is the more broadly reusable takeaway.

No blockers for 215-03 onward. This plan is its own squash-merge unit per the plan's own merge-discipline note (wave-2 plans share `eslint.config.js`'s baseline region and are merged sequentially, not in parallel worktrees) — 215-03 can proceed once this plan's branch state is available to merge against.

---
*Phase: 215-frontend-god-file-decomposition*
*Completed: 2026-09-03*

## Self-Check: PASSED

- FOUND: `frontend/src/lib/engine/workerPool.ts`
- FOUND: `frontend/src/lib/engine/workerPoolState.ts`
- FOUND: `frontend/src/lib/engine/workerPoolWatchdog.ts`
- FOUND: `frontend/src/lib/engine/workerPoolDispatch.ts`
- FOUND: `frontend/src/lib/engine/workerPoolLifecycle.ts`
- FOUND commit `426974d91` (Task 1)
- FOUND commit `b38646f7f` (Task 2)
- FOUND commit `0c156f1ec` (Task 3)
- Re-ran `npx vitest run src/lib/engine/__tests__/workerPool.test.ts`: 109/109 passed
- Re-ran `max-lines-per-function` at 200 across all five files: exit 0 (`createWorkerPool` at 99 lines)
