---
phase: 213-first-run-engine-cold-start-ux
plan: 08
subsystem: engine
tags: [react, typescript, web-worker, wasm, engine-assets, performance, gap-closure]

# Dependency graph
requires:
  - phase: 213-first-run-engine-cold-start-ux
    provides: "engineAssetProgress.ts store (markEngineAssetPending/reportEngineAssetProgress/markEngineAssetReady), the CR-02 synchronous-pending contract, and the EngineReadyGate consuming 'stockfish-wasm' (Plans 01-07)"
provides:
  - "frontend/src/lib/engine/stockfishWorkerSource.ts — the single owner of Stockfish Worker construction: ensureStockfishWorkerUrl() (memoised, one streamed fetch, never rejects) and createStockfishWorker(sharedUrl)"
  - "Every Stockfish Worker construction site (useStockfishEngine, workerPool's N pool slots, useStockfishGradingEngine, useTrainGradingEngine) routed through the shared module — a source gate proves no other file constructs one"
  - "stockfish-wasm store accounting reduced to ONE 7,295,411-byte transfer's numerator against ONE transfer's denominator, regardless of how many Workers spawn"
affects: [213-09]

# Actuals (#2632)
actuals:
  tokens: 30500
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared main-thread fetch + Blob object URL + location-hash override: one streamed network transfer published as an application/wasm Blob, handed to every Worker via the vendored glue's own already-shipped self.location.hash wasm-path override — no vendored file edited"
    - "Async-at-the-seam spawn: a pool/hook's construction step becomes a .then() continuation off a memoised shared promise, guarded by a cancelled flag (unmount races) and a monotonic generation counter (workerPool's terminate-mid-fetch race), while every OTHER seam (registration, idempotence latch) stays synchronous"
    - "Test-only synchronous thenable — a { then: (fn) => fn(value) } double that resolves a mocked async dependency in the SAME synchronous call rather than a real microtask, letting ~150 pre-existing mock-Worker tests keep asserting on worker construction with zero await added, while new tests override the mock with a real controlled Promise to exercise the actual async race"

key-files:
  created:
    - frontend/src/lib/engine/stockfishWorkerSource.ts
    - frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts
  modified:
    - frontend/src/hooks/useStockfishEngine.ts
    - frontend/src/hooks/__tests__/useStockfishEngine.test.ts
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts
    - frontend/src/hooks/useStockfishGradingEngine.ts
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/hooks/__tests__/useStockfishGradingEngine.test.ts
    - frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts

key-decisions:
  - "Tracer feedback gate (Task 1) treated as the autonomous branch, matching the 213-06/213-07 precedent: this is an unattended worktree executor run with no interactive user to answer a mid-plan checkpoint. The tracer's own <verify> was re-run and passed before Task 2 began."
  - "Test-file blast radius (workerPool.test.ts's ~99 pre-existing cases, plus the two grading hooks' suites) was resolved with a synchronous-thenable mock for stockfishWorkerSource's default resolution, rather than adding an await-microtask-flush to every pre-existing test. This kept every pre-existing assertion byte-for-byte unchanged while still letting new tests exercise the real async race by overriding the mock with a controlled Promise."
  - "createSlot()/replaceDeadSlot() never re-invoke ensureStockfishWorkerUrl() for a respawned slot — the resolved shared URL is cached in a closure variable (resolvedSharedUrl) the first spawn sets, so a mid-session slot death never re-triggers or waits on the shared fetch."
  - "workerPool.ts's ENGINE_PATH export removed only in Task 3, after a repo-wide grep (including scripts/*.mjs) confirmed zero external importers — kept through Task 2 to respect the plan's per-task file boundary."

requirements-completed: [G-213-35]

coverage:
  - id: D1
    description: "The 7,295,411-byte Stockfish .wasm is transferred EXACTLY ONCE per page load, no matter how many Stockfish Workers the page constructs (analysis board constructs 5-8)"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts#ensureStockfishWorkerUrl — single-fetch memoisation (2 cases + mutation check)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts#accounting: numerator equals denominator for one transfer"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#a slot that dies is replaced with a worker built from the SAME shared URL — no re-fetch, no re-await"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every Stockfish Worker in the app is constructed through one shared source module; no consumer reaches the vendored glue directly — enforced by a source gate, not symbol presence"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts#source gate: only stockfishWorkerSource.ts constructs a Stockfish Worker"
        status: pass
      - kind: other
        ref: "Mutation proof: a direct new Worker('/engine/stockfish-18-lite-single.js') temporarily reintroduced in useStockfishEngine.ts made the gate fail; reverted"
        status: pass
    human_judgment: false
  - id: D3
    description: "The stockfish-wasm numerator and denominator both describe ONE 7,295,411-byte transfer, matching what the Network tab would report for Stockfish"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts#ensureStockfishWorkerUrl — accounting: numerator equals denominator for one transfer"
        status: pass
    human_judgment: false
  - id: D4
    description: "The shared fetch is triggered only at the spawn seams that already existed — nothing fetched at import time, nothing speculative (D-08)"
    requirement: G-213-35
    verification:
      - kind: other
        ref: "Source review: ensureStockfishWorkerUrl() is called only from within useStockfishEngine's/useStockfishGradingEngine's/useTrainGradingEngine's worker-lifecycle effects and workerPool.ts's ensureSpawned() — no module-scope call site exists anywhere in the shared module or its consumers"
        status: pass
    human_judgment: false
  - id: D5
    description: "A failed shared fetch degrades every consumer to today's direct construction and the engine still works — never able to break engine spawn (T-213-07)"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts#ensureStockfishWorkerUrl — failure degradation (T-213-07) (4 cases: rejection, 404, 500, absent body/createObjectURL)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#a shared URL of null still spawns the full computePoolSize() pool and the pool behaves exactly as it does today"
        status: pass
    human_judgment: false
  - id: D6
    description: "A worker that fails to construct still leaves the pool with whatever slots succeeded (Pitfall 1); a pool where every construction failed still reaches markPoolFailed() rather than hanging (CR-01)"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#a grade() issued after the shared fetch resolved and every construction attempt threw resolves empty rather than hanging, and the pool is marked failed"
        status: pass
    human_judgment: false
  - id: D7
    description: "grade() still settles every promise it returns — a request issued while the shared fetch is in flight is queued and dispatched once slots appear, never silently resolved empty"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#a grade() issued while the shared fetch is still in flight is QUEUED and resolves with real grades once slots appear and report readyok"
        status: pass
      - kind: other
        ref: "Mutation proof: reverting grade()'s in-flight guard to its unconditional pre-fix form made both the queued-request test AND a dedicated mutation-check test fail; reverted"
        status: pass
    human_judgment: false
  - id: D8
    description: "CR-02 holds: stockfish-wasm is registered pending synchronously at the moment the shared fetch begins, before any progress or ready message can arrive"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts#ensureStockfishWorkerUrl — CR-02 synchronous pending registration"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#markEngineAssetPending('stockfish-wasm') still happens synchronously inside ensureSpawned(), before it returns — even while the shared fetch is deferred"
        status: pass
    human_judgment: false
  - id: D9
    description: "Cold-cache Network-tab check confirms exactly ONE Stockfish .wasm request with DevTools 'Disable cache' on, the engines still produce output, and blocking the .wasm URL still lets the engine come up via the degraded direct path"
    verification: []
    human_judgment: true
    rationale: "No automated check can observe real network timing/transfer count against a live browser Network tab. The plan's own <verification> section frames this explicitly as a pre-handoff spawn-correctness smoke check, NOT the gap's closing acceptance check — that lives in plan 213-09, which needs both plans in place. Per this project's human_verify_mode: end-of-phase default, deferred to end-of-phase UAT alongside 213-09's own human checks."

duration: 105min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 08: Shared Stockfish Wasm Source (Gap Closure, G-213-35) Summary

**One streamed main-thread fetch of the 7.3 MB Stockfish `.wasm`, published as a Blob object URL and handed to every Worker (standalone engine, 2-4 pool slots, both grading hooks) through the vendored glue's own location-hash wasm-path override — cutting 5-8 duplicate network transfers per analysis-board load down to exactly one.**

## Performance

- **Duration:** ~105 min
- **Tasks:** 3 completed
- **Files modified:** 10 (2 created, 8 modified — 4 production, 4 test)

## Accomplishments

- `frontend/src/lib/engine/stockfishWorkerSource.ts` is the new single owner of Stockfish Worker construction. `ensureStockfishWorkerUrl()` memoises exactly one streamed `.wasm` fetch behind a module-level promise (concurrent AND repeat callers all join the same promise), registers `stockfish-wasm` pending synchronously before the fetch is even awaited (CR-02), reports every streamed chunk through `reportEngineAssetProgress`, and NEVER rejects — every failure mode (network rejection, non-ok response, absent body, absent `URL.createObjectURL`/`Blob`) resolves `null` and reports once to Sentry. `createStockfishWorker(sharedUrl)` constructs against the served glue path directly when `sharedUrl` is `null`, or via the glue's own already-shipped `#`-encoded location-hash override otherwise (`encodeURIComponent` guarantees no raw comma, which matters for the glue's pthread guard).
- All four Stockfish Worker construction sites now route through it: the standalone `useStockfishEngine` worker, `workerPool.ts`'s `createSlot()`/`replaceDeadSlot()` (2-4 pool slots plus any respawns), and both grading hooks (`useStockfishGradingEngine`, `useTrainGradingEngine`). Each construction site is guarded by a `cancelled` flag (or, in `workerPool.ts`, a `spawnInFlight` boolean plus a monotonic `spawnGeneration` counter) so an unmount or `terminate()` racing the shared fetch never leaks a worker or pushes slots into a torn-down pool.
- `workerPool.ts`'s `ensureSpawned()` is asynchronous at the construction-loop seam only — `spawned`/`markEngineAssetPending` stay synchronous. `grade()`'s first zero-slot guard now only short-circuits when no spawn is in flight, so a request arriving mid-fetch is queued and dispatched once slots appear (never silently resolved empty), while a totally failed spawn still calls `markPoolFailed()` + `drainPending()`. A slot death (`replaceDeadSlot()`) reuses the already-resolved shared URL — no re-fetch, no re-await.
- Both load-bearing behaviors were proven load-bearing by a recorded revert, not by symbol presence: the single-fetch memoisation guard (removing it broke 3 tests) and `grade()`'s queue-instead-of-empty in-flight gate (reverting it broke 2 tests, including a dedicated mutation-check test). A third mutation check proved the Task 3 source gate actually fires (temporarily reintroducing a direct `new Worker(...)` call broke the gate; reverted).
- A source-level gate in `stockfishWorkerSource.test.ts` reads every non-test file under `frontend/src`, strips comment-only lines, and asserts the Stockfish glue-path literal appears in exactly one file — the shared module. An accounting assertion drives a full simulated download then constructs several workers, confirming the `stockfish-wasm` store entry's `total` and `loaded` both equal exactly `STOCKFISH_WASM_BYTES_FALLBACK` — one transfer's numerator against one transfer's denominator.
- `workerPool.ts`'s now-redundant exported `ENGINE_PATH` constant was removed in Task 3, after a repo-wide grep (including `scripts/*.mjs`) confirmed zero external importers.
- Test-file blast radius (this refactor makes worker construction asynchronous, which ~150 pre-existing mock-Worker tests across 4 files assumed was synchronous) was resolved with a synchronous "thenable" mock double for the default `ensureStockfishWorkerUrl()` resolution — a `.then()` that invokes its callback in the SAME synchronous call rather than a real deferred microtask — keeping every pre-existing test's assertions unchanged while new tests override the mock with a real controlled `Promise` to exercise the actual async spawn race (in-flight queueing, terminate-mid-fetch, total-failure).
- Full frontend suite green: 244 test files / 3738 tests, `npm run lint`/`npm run knip`/`npm run build` clean.

## Task Commits

1. **Task 1: One shared Stockfish wasm source, proven end to end on the standalone worker** — `6f3ac8981` (feat, tracer)
2. **Task 2: Route the worker pool's slots through the shared source without stranding a grade()** — `fc917dc2d` (feat)
3. **Task 3: Route the two grading hooks through the same source and close the door on direct construction** — `5aea7478e` (feat)

_Tracer task (Task 1) followed a real implementation + verify + commit, then its own `<verify>` was re-run end-to-end and passed before Task 2 began. This is an unattended worktree executor run (no interactive user to answer a mid-plan checkpoint), so per the 213-06/213-07 precedent the tracer gate was treated as the autonomous branch: expansion (Tasks 2-3) proceeded immediately after the tracer's verify confirmed green._

## Files Created/Modified

- `frontend/src/lib/engine/stockfishWorkerSource.ts` — new: `ensureStockfishWorkerUrl()`, `createStockfishWorker()`, `resetStockfishWorkerSourceForTests()`, `STOCKFISH_ENGINE_GLUE_PATH`/`STOCKFISH_ENGINE_WASM_PATH`
- `frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts` — new: 18 cases covering memoisation, CR-02, streaming progress, failure degradation, the construction contract, the Task 3 source gate, and the accounting assertion
- `frontend/src/hooks/useStockfishEngine.ts` — worker-lifecycle effect restructured into `setupWorker`/`runWorkerHandshake` behind `ensureStockfishWorkerUrl().then(...)`; local `ENGINE_PATH` constant deleted
- `frontend/src/hooks/__tests__/useStockfishEngine.test.ts` — mocks `stockfishWorkerSource`, adds a `flushWorkerSpawn()` microtask helper used after the initial render, adds a new unmount-before-resolve test
- `frontend/src/lib/engine/workerPool.ts` — `createSlot(sharedUrl)`, async-at-the-seam `ensureSpawned()`/`runSpawnConstructionLoop()`, `spawnInFlight`/`spawnGeneration`/`resolvedSharedUrl` state, `grade()`'s adjusted zero-slot guard, `terminate()`'s generation bump; exported `ENGINE_PATH` removed
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` — mocks `stockfishWorkerSource` with a synchronous-thenable default (99 pre-existing tests unchanged), adds a 10-case describe block for the new async spawn seam
- `frontend/src/hooks/useStockfishGradingEngine.ts` — worker-lifecycle effect restructured identically to Task 1's pattern; local `ENGINE_PATH` constant deleted
- `frontend/src/hooks/useTrainGradingEngine.ts` — same restructuring; local `ENGINE_PATH` constant deleted
- `frontend/src/hooks/__tests__/useStockfishGradingEngine.test.ts` / `useTrainGradingEngine.test.ts` — same synchronous-thenable mock pattern; all pre-existing tests unchanged

## Decisions Made

See `key-decisions` in frontmatter: tracer gate autonomous-branch precedent, synchronous-thenable mock strategy for test-blast-radius containment, `resolvedSharedUrl` closure caching for respawns, and deferred `ENGINE_PATH` removal to Task 3.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — adjacent test breakage caused directly by this task's own change] Making worker construction asynchronous broke ~150 pre-existing mock-Worker tests across 4 test files not listed in the plan's `<files>` for Tasks 1-2**
- **Found during:** Task 1, immediately after restructuring `useStockfishEngine.ts`'s worker-lifecycle effect
- **Issue:** `useStockfishEngine.test.ts` (23 tests), `workerPool.test.ts` (99 tests), `useStockfishGradingEngine.test.ts` (11 tests), and `useTrainGradingEngine.test.ts` (25 tests) all assumed `new Worker(...)` fired synchronously inside `renderHook()`/`pool.grade()`/`pool.warm()` — a direct, necessary consequence of moving construction behind `ensureStockfishWorkerUrl().then(...)`, not a pre-existing defect these tests happened to expose.
- **Fix:** For `useStockfishEngine.test.ts`, added a `flushWorkerSpawn()` microtask-flush helper awaited once after the initial render in every affected test. For the other three files, discovered that a **synchronous "thenable"** mock (`{ then: (fn) => fn(value) }`, which invokes its callback in the SAME synchronous call rather than deferring to a real microtask) for the default `ensureStockfishWorkerUrl()` resolution keeps ~135 of those pre-existing tests passing completely unchanged — no await, no flush helper needed — because `ensureSpawned()`'s/`setupWorker`'s `.then()` call resolves synchronously against a non-native-Promise thenable. New tests specifically exercising the real async race override this default with a genuine controlled `Promise` via `mockImplementationOnce`.
- **Files modified:** `frontend/src/hooks/__tests__/useStockfishEngine.test.ts`, `frontend/src/lib/engine/__tests__/workerPool.test.ts`, `frontend/src/hooks/__tests__/useStockfishGradingEngine.test.ts`, `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts`
- **Verification:** Full frontend suite green (244 files / 3738 tests) after all three task commits.
- **Committed in:** `6f3ac8981` (Task 1, `useStockfishEngine.test.ts`), `fc917dc2d` (Task 2, `workerPool.test.ts`), `5aea7478e` (Task 3, the two grading-hook test files)

---

**Total deviations:** 1 documented (structural test-suite adaptation, not a code defect)
**Impact on plan:** None on shipped behavior — every pre-existing test's own assertions are byte-for-byte unchanged (only the mock setup and, for `useStockfishEngine.test.ts`, one added await per test, were touched). The synchronous-thenable technique is now a reusable pattern for future async-spawn refactors in this codebase's Worker-heavy engine layer.

## Issues Encountered

- **jsdom's `URL` global shadow broke `fileURLToPath()`** in the new source-gate test (`@vitest-environment jsdom` replaces the global `URL` constructor, and `node:url`'s `fileURLToPath` rejects a jsdom `URL` instance as not a real Node one). Fixed by importing `URL as NodeURL` from `node:url` explicitly rather than relying on the global. Not a deviation from the plan — a test-infrastructure gotcha specific to writing a Node `fs`-based test inside a `jsdom`-environment file.
- **A JSDoc comment containing a literal `*/` inside a backtick-quoted description broke the Vite/oxc parser** (`/** ... \`grep -v '^\s*[*/]'\` ... */` — the embedded `*/` closes the comment early). Rephrased the comment to avoid the literal token combination.

## User Setup Required

None — no external service configuration required.

## Verification

Task 1 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/stockfishWorkerSource.test.ts && npm run build` — 16/16 tests pass (grew to 18 after Task 3's additions), build clean.

Task 2 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/workerPool.test.ts` — 109/109 tests pass.

Task 3 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/stockfishWorkerSource.test.ts src/lib/engine/__tests__/workerPool.test.ts && npm run lint && npm run knip && npm run build` — 127/127 combined tests pass; lint, knip, build all clean.

Plan-level `<verification>`: `cd frontend && npm run lint && npm run knip && npm run build && npm test -- --run` — lint/knip/build clean; **244 test files / 3738 tests passed** on re-run, except the documented pre-existing flake `Train.guestGate.test.tsx` (1/6 cases timed out under the full parallel run) — re-run standalone and confirmed 6/6 pass, matching the plan's own documented flake note (213-05-SUMMARY.md).

Mutation proofs (all restore-then-revert, all confirmed load-bearing):
- `ensureStockfishWorkerUrl()`'s memoisation guard removed → the two single-fetch tests AND a dedicated mutation-check test failed (10 calls instead of 1); reverted.
- `grade()`'s in-flight zero-slot guard reverted to its unconditional pre-fix form → the queued-request test AND a dedicated mutation-check test failed (settled empty instead of queuing); reverted.
- A direct `new Worker('/engine/stockfish-18-lite-single.js')` call temporarily reintroduced in `useStockfishEngine.ts` → the Task 3 source gate failed (2 offending files instead of 1); reverted.

Source assertions (all pass):
- `grep -rln "stockfish-18-lite-single" frontend/src --include="*.ts" --include="*.tsx" | grep -v __tests__` → exactly `workerPool.ts` (comment only) and `stockfishWorkerSource.ts` (code) — confirmed by the automated source gate.
- `grep -rn "ENGINE_PATH" frontend/src frontend/scripts/*.mjs` (pre-removal) → zero external importers of `workerPool.ts`'s export, confirming the Task 3 removal was safe.

**Blocking human check not yet run** (see coverage D9): the plan's own `<verification>` section names a cold-cache DevTools Network-tab smoke check (4 numbered steps: confirm exactly one `.wasm` request with "Disable cache" checked, confirm both engine cards still produce output, confirm blocking the `.wasm` URL still lets the engine come up degraded) as a pre-handoff spawn-correctness check — explicitly NOT the gap's closing acceptance check, which lives in plan 213-09 and needs both plans in place. Deferred to end-of-phase UAT per this project's `human_verify_mode: end-of-phase` default.

Pre-merge gate (ruff/ty/pytest for backend) is deferred to the phase's own squash-merge step per this plan's own `<verification>` note — this plan is frontend-only, and the gate runs once before integration, not per plan.

## Next Phase Readiness

- G-213-35's automated proof is complete: single fetch (memoisation + mutation-proven), single construction site (source gate, mutation-proven), accurate accounting (numerator = denominator = one transfer), queue-instead-of-empty (mutation-proven), graceful degradation on every failure mode, and CR-01/CR-02 preserved.
- The gap can be marked resolved once plan 213-09's own work lands and the combined cold-cache Network-tab human check (D9 above) confirms no defect reaches the real browser network layer.
- The `CHANGELOG.md` entry ("the chess engine now downloads once instead of once per worker, so the first visit to the analysis board transfers tens of megabytes less") is due when this work merges to `main`, per the plan's own `<verification>` note — not added by this plan (frontend-only work, changelog entries land at merge time per `docs/git-workflow.md`).

## Self-Check: PASSED

- `frontend/src/lib/engine/stockfishWorkerSource.ts` — FOUND, contains `ensureStockfishWorkerUrl`, `createStockfishWorker`, `resetStockfishWorkerSourceForTests`
- `frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts` — FOUND, contains the source-gate and accounting-assertion describe blocks
- `frontend/src/lib/engine/workerPool.ts` — FOUND, no `ENGINE_PATH` export, contains `createStockfishWorker`, `spawnInFlight`, `spawnGeneration`, `resolvedSharedUrl`
- `frontend/src/hooks/useStockfishEngine.ts` — FOUND, no local `ENGINE_PATH` constant, contains `createStockfishWorker`, `ensureStockfishWorkerUrl`
- `frontend/src/hooks/useStockfishGradingEngine.ts` — FOUND, no local `ENGINE_PATH` constant
- `frontend/src/hooks/useTrainGradingEngine.ts` — FOUND, no local `ENGINE_PATH` constant
- Commit `6f3ac8981` — FOUND in `git log --oneline --all`
- Commit `fc917dc2d` — FOUND in `git log --oneline --all`
- Commit `5aea7478e` — FOUND in `git log --oneline --all`

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*
