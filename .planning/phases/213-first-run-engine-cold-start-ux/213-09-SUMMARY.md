---
phase: 213-first-run-engine-cold-start-ux
plan: 09
subsystem: engine
tags: [react, typescript, web-worker, wasm, onnxruntime-web, webgpu, engine-assets, performance, gap-closure]

# Dependency graph
requires:
  - phase: 213-first-run-engine-cold-start-ux
    provides: "plan 213-08's shared Stockfish wasm source module and its 'one main-thread fetch, streamed, reported under an asset id, never rejects' idiom — this plan is its sibling for the ORT runtime binary"
provides:
  - "frontend/src/lib/engine/ortRuntimeSource.ts — the single main-thread owner of the onnxruntime-web runtime .wasm binary: ensureOrtRuntime() (adapter-probe-then-fetch, memoised) and fetchWasmOnlyOrtRuntime() (the wasm-only respawn path)"
  - "maiaWorkerHost.ts's spawn() is async-at-the-seam: resolves the runtime binary + backend BEFORE constructing the Worker, hands both to it via a transferred ArrayBuffer, and the worker no longer probes navigator.gpu or picks its own bundle"
  - "'ort-runtime' as the third EngineAssetId/gate asset, registered pending alongside 'maia-model' (CR-02) and marked done on InferenceSession.create() success on every path including the degraded null-buffer one"
affects: []

# Actuals (#2632)
actuals:
  tokens: 28900
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Main-thread capability probe before Worker construction: the WebGPU adapter's shader-f16 feature is inspected on the main thread, choosing exactly one runtime build BEFORE any Worker exists — the worker itself never probes navigator.gpu and never picks between bundles, closing the double-fetch defect an in-worker probe could only ever narrow"
    - "Async-at-the-seam spawn (second application, following 213-08's workerPool.ts precedent): maiaWorkerHost's spawn() defers Worker construction behind an awaited runtime fetch, guarded by an in-flight flag (re-entry is a no-op, not a second spawn) and a generation counter (a last-lease-release mid-fetch constructs nothing into a torn-down module state)"
    - "Synchronous-thenable test double (second application): maiaWorkerHost.test.ts mocks ortRuntimeSource's two exports with a `{ then: (fn) => fn(value) }` double so ~25 pre-existing tests asserting on `createdWorkers` immediately after `analyze()`/`whenReady()` — no await — kept working completely unchanged"
    - "node:vm sandbox drives a served, non-bundled classic Worker script end-to-end: maiaWorkerScript.test.ts runs the REAL frontend/public/maia/maia-worker.js via vm.runInContext against a fake self/importScripts/fetch/ort, asserting the message protocol without instantiating real onnxruntime-web"

key-files:
  created:
    - frontend/src/lib/engine/ortRuntimeSource.ts
    - frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts
  modified:
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - frontend/public/maia/maia-worker.js
    - frontend/public/maia/README.md
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - frontend/src/hooks/__tests__/useBotGame.test.ts
    - frontend/src/pages/__tests__/Analysis.test.tsx

key-decisions:
  - "Task 1's blocking wasmBinary gate resolved EMPIRICALLY (not by reading docs) headlessly in Node: both vendored .mjs loaders were driven directly with fs.readFileSync instrumented, proving zero .wasm reads with wasmBinary set (vs exactly one without it) for BOTH the wasm-only and asyncify builds. The design proceeded as planned — no HALT needed, no narrowing to a wasm-only-only approach."
  - "ORT_RUNTIME_BYTES_FALLBACK (the gate's pre-selection placeholder before Content-Length is known) is deliberately the SMALLER wasm-only figure (13,479,978), not the larger asyncify one (24,254,953) — most devices lack the WebGPU f16 feature, and the real total replaces the placeholder before any byte of the asset is visibly reported, so there is no user-visible backwards jump either way."
  - "fetchWasmOnlyOrtRuntime() is a SEPARATE, non-memoised export from ensureOrtRuntime() — the webgpu->wasm respawn needs a fetch that bypasses the adapter probe entirely and does NOT join the (differently-backended) memoised promise the initial spawn already resolved."
  - "resetEngineAssetForRefetch('ort-runtime') in respawnPinnedToWasm() is UNCONDITIONAL (unlike the existing conditional 'maia-model' reset) — this respawn path only ever follows a WebGPU attempt, so the replacement's binary is ALWAYS different bytes, never sometimes-handed-over like the model buffer."
  - "The mode==='wasm' spawn branch calls .then() directly on fetchWasmOnlyOrtRuntime()'s own return value rather than composing an extra .then() to unify its shape with ensureOrtRuntime()'s — composing a second .then() silently converted the test double's synchronous callback into a real microtask hop for that one branch, breaking 3 pre-existing respawn tests before this was caught and fixed."

requirements-completed: [G-213-35]

coverage:
  - id: D1
    description: "Exactly ONE onnxruntime-web runtime binary is transferred per page load — the build is chosen on the main thread before any Worker exists, so a device lacking WebGPU f16 never requests the 24.3 MB asyncify build at all"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts#ensureOrtRuntime — backend selection falls safe to wasm (7 cases: f16 adapter, no-f16 adapter, no navigator.gpu, null adapter, rejecting adapter, no feature set, throwing has())"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts#ensureOrtRuntime — single-fetch memoisation (3 cases + mutation check)"
        status: pass
      - kind: other
        ref: "Task 1 empirical gate: headless Node run against both real vendored .mjs loaders with fs.readFileSync instrumented — 0 .wasm reads with wasmBinary set (both builds), 1 without it"
        status: pass
    human_judgment: false
  - id: D2
    description: "The runtime binary's bytes are counted by the gate — streamed through a reader and registered under 'ort-runtime', no longer invisible transfer"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts#ensureOrtRuntime — streamed progress reporting (4 cases: chunked, wasm fallback, webgpu fallback, garbage content-length)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#CR-02 registers ort-runtime pending in the SAME synchronous call as maia-model"
        status: pass
    human_judgment: false
  - id: D3
    description: "The gate's denominator sums all three assets, and the percentage is monotonic — never walks backwards when the exact runtime total replaces the fallback estimate"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#useEngineAssets — three-asset denominator (Phase 213-09 adds ort-runtime)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#reportEngineAssetProgress — ort-runtime monotonicity across the estimate-to-exact transition"
        status: pass
    human_judgment: false
  - id: D4
    description: "BOTH SURFACES: bot play and the analysis board are served by the SAME shared runtime fetch — both reach the worker through acquireMaiaWorker(), both mount EngineReadyGate, both count ort-runtime in their denominator"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#BOTH SURFACES: two leases with different sources share exactly ONE runtime fetch"
        status: pass
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#describe.each(['bots','analysis']) — three-asset denominator, per-surface copy, ready gated on all three, exactly one gate/progress element"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-13 still gates everything: supportsWasmSimd() is probed BEFORE any runtime fetch, so a device that can never run the model spends zero bytes"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#D-13: a device without WASM SIMD issues ZERO runtime-fetch calls"
        status: pass
    human_judgment: false
  - id: D6
    description: "CR-02 holds for the new id, no device is ever locked behind an asset nothing marks done, and a runtime fetch failure never breaks engine spawn"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#the worker's ready message marks ort-runtime done in the store — on every path, including the degraded null-buffer one"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#T-213-09-02: a null runtime buffer (degraded fetch) still spawns the worker"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts#ensureOrtRuntime — failure degradation (3 cases: rejected fetch, 404, absent body)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The spawn seam becoming async does not drop or double-spawn: concurrent ensureSpawned() calls join one fetch, and analyze()/whenReady() issued mid-fetch are queued, never dropped"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#T-213-09-03: concurrent ensureSpawned() calls during the in-flight runtime fetch issue exactly ONE fetch and construct exactly ONE Worker"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#T-213-09-03: an analyze() issued while the runtime fetch is still in flight is QUEUED and resolves once the worker becomes ready"
        status: pass
    human_judgment: false
  - id: D8
    description: "The webgpu->wasm respawn requests the wasm-only build directly (not the memoised, differently-backended promise) and re-counts the different binary honestly, while the model-buffer handoff (G-213-8) stays untouched"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#the webgpu-unavailable respawn requests the wasm-only runtime directly via fetchWasmOnlyOrtRuntime(), not ensureOrtRuntime() again"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#the webgpu-unavailable respawn resets ort-runtime for refetch — the replacement is a DIFFERENT binary"
        status: pass
    human_judgment: false
  - id: D9
    description: "The worker script correctly imports only the told-to backend's glue, forces numThreads=1 before every session create, and sets/clears wasmBinary around create() on both paths"
    requirement: G-213-35
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts (11 cases across backend: wasm, backend: webgpu, and unrecognised/absent backend defaulting)"
        status: pass
    human_judgment: false
  - id: D10
    description: "Cold-cache cross-browser DevTools check (Chrome + Brave) confirms the accounted total matches the real transferred total, one runtime request per build (asyncify absent entirely on non-f16 Brave), and bot play issues ZERO new engine requests after the analysis board already warmed the cache"
    verification: []
    human_judgment: true
    rationale: "No automated check can observe real network timing/request count against a live browser Network tab across two distinct browser engines. This is the plan's own Task 4 checkpoint (gate=blocking-human) — a numeric DevTools comparison the plan explicitly rules unfalsifiable-by-impression ('the bar looks smooth' is NOT sufficient). The executor started the dev server (http://localhost:5180/, proxying /api to the already-running shared backend on :8000) and is stopping here per the plan's autonomous:false frontmatter and this checkpoint's blocking-human gate — it is never auto-approved, in any mode."

duration: 40min
completed: 2026-08-29
status: halted
---

# Phase 213 Plan 09: Main-Thread ORT Runtime Ownership (Gap Closure, G-213-35 Second Half) Summary

**The onnxruntime-web runtime `.wasm` binary is now chosen by a main-thread WebGPU adapter probe and streamed once by the main thread — the worker no longer probes `navigator.gpu` or fetches its own runtime, closing the "both builds fetched" defect (37.8 MB down to at most 24.3 MB) and making the binary's bytes finally visible to the gate as a third counted asset.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3 of 4 completed (Task 4 is a `checkpoint:human-verify`, `gate="blocking-human"` — stopped here per plan)
- **Files modified:** 12 (3 created, 9 modified — 5 production, 7 test)

## Accomplishments

- **Task 1's blocking gate resolved empirically, not by reading docs.** Both vendored `.mjs` runtime loaders (`ort-wasm-simd-threaded.mjs` and its `.asyncify` sibling) were copied into an isolated directory and driven directly under plain Node with `fs.readFileSync` instrumented. Result for BOTH builds: exactly one `.wasm` read without `wasmBinary` set, ZERO reads with it set to the real vendored bytes. Source-level confirmation: both loaders gate their fetch/read behind the same closure variable `Module.wasmBinary` populates (`if(!q) ... await ha(a)` for the sync getter, `if(!q&&!isDataUri&&!isNode) fetch(...)` for the streaming path). No divergence between builds — the design proceeded as planned, no HALT.
- **`frontend/src/lib/engine/ortRuntimeSource.ts`** is the new single main-thread owner of the runtime binary. `ensureOrtRuntime()` probes the WebGPU adapter's `shader-f16` feature (every malformed/absent shape — no `navigator.gpu`, null adapter, rejecting `requestAdapter()`, missing feature set, throwing `.has()` — falls safe to wasm), selects exactly one build, streams it with a progress-reporting reader under the `ort-runtime` asset id, and NEVER rejects (a failure resolves `{ backend, buffer: null }`). Memoised: N callers share one fetch. `fetchWasmOnlyOrtRuntime()` is a separate, non-memoised export for the webgpu->wasm respawn, which needs a different (and definitely-fetched) build without reusing the initial spawn's memoised, differently-backended promise.
- **`maiaWorkerHost.ts`'s `spawn()` is now async at the seam** (the same pattern plan 213-08 established for `workerPool.ts`): it resolves the runtime binary + backend BEFORE constructing the Worker, guarded by a `spawnInFlight` flag (concurrent `ensureSpawned()` calls during the fetch are a no-op, not a second spawn) and a `spawnGeneration` counter (a last-lease-release mid-fetch constructs nothing into an already-torn-down module state). Both `markEngineAssetPending('maia-model')` and `('ort-runtime')` fire in the same synchronous prelude (CR-02); both are marked done only in the `ready` handler, which fires only after `InferenceSession.create()` succeeds — on every path, including the degraded null-buffer one, so the non-dismissible gate can never lock a device out behind an asset nothing marks done.
- **`maia-worker.js`** no longer probes `navigator.gpu` or chooses between bundles — `initSession`/`initWasmOnlySession` now take an explicit `chosenBackend` from the host's init message, `importScripts` only the told-to glue, and (when a `runtimeBuffer` was transferred) set `ort.env.wasm.wasmBinary` before `InferenceSession.create()` and clear it immediately after success, freeing the duplicate 13.5-24.3 MB buffer for GC.
- **`engineAssetProgress.ts`** gains `'ort-runtime'` as the third `EngineAssetId`, with a deliberately-chosen SMALLER wasm-only fallback byte figure (13,479,978, not the 24.3 MB asyncify one) as the pre-`Content-Length` placeholder — most devices lack the f16 feature, and the real total replaces the placeholder before any byte is visibly reported either way. `requiredEngineAssets()`/`engineGateRequired()` already iterated the shared array, so both `EngineReadyGate` mounts (`Bots.tsx` surface="bots", `Analysis.tsx` surface="analysis") picked up the third asset with zero component changes.
- **New `maiaWorkerScript.test.ts`** drives the REAL vendored `maia-worker.js` end-to-end via `node:vm`'s `runInContext` against a fake `self`/`importScripts`/`fetch`/`ort`, asserting the message protocol directly: only the told-to backend's glue is imported, `numThreads` is 1 before every `create()`, and `wasmBinary` is set from a supplied buffer then cleared after `create()` succeeds (both backends), with an unrecognised/absent backend value falling safe to wasm.
- **[Rule 1 deviation] Fixed 59-test regression in `useBotGame.test.ts` caused directly by Task 3's own change**, plus the equivalent (would-have-been) breakage in `Analysis.test.tsx`: both files' shared `beforeEach` primed only `'maia-model'`/`'stockfish-wasm'` as seen, so `engineGateRequired()` stayed `true` for every test once `'ort-runtime'` became a third required member, defeating the whole-file "warm cache, no gate" default. Fixed by priming all three; full suite verified green after (246 files / 3795 tests).
- **[Deviation, caught mid-Task-2] A composed extra `.then()` on `fetchWasmOnlyOrtRuntime()`'s return value silently converted the mode='wasm' respawn path's test double into a real microtask hop**, breaking 3 pre-existing respawn tests. Fixed by branching on `mode` before the single `.then()` call rather than composing a second one on top of it — caught and fixed within the same task, documented as a key-decision above.
- Plan-level `<verification>` (lint/knip/build/full test suite) all green: `npm run lint` clean, `npm run knip` clean (0 unused exports — the new `ortRuntimeSource.ts` module's exports are all consumed), `npm run build` clean (`tsc -b` confirms the 'ort-runtime' type gap Task 1 deliberately left open closes cleanly by Task 3), full suite 246 test files / 3795 tests passed.

## Task Commits

1. **Task 1: Prove `wasmBinary` is honoured, then build the main-thread runtime source** — `fb45bb684` (feat, tdd)
2. **Task 2: Hand the bytes to the worker at spawn — one seam, both surfaces** — `5c7e934db` (feat, tdd)
3. **Task 3: Register `ort-runtime` as a gate asset on both mounts** — `b64524f7a` (feat, tdd)
4. **[Deviation] Fix pre-existing test suites broken by Task 3's third required asset** — `bf7c0c8d7` (fix)

_Task 4 (`checkpoint:human-verify`, `gate="blocking-human"`) is NOT executed by this run — see "Next Phase Readiness" below. This plan's `autonomous: false` frontmatter and Task 4's `blocking-human` gate mean it is never auto-approved by an executor, in any mode._

## Files Created/Modified

- `frontend/src/lib/engine/ortRuntimeSource.ts` — new: `ensureOrtRuntime()`, `fetchWasmOnlyOrtRuntime()`, `resetOrtRuntimeSourceForTests()`, the two `ORT_RUNTIME_*_PATH`/`*_BYTES_FALLBACK` constant pairs
- `frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts` — new: 22 cases covering backend selection, memoisation, CR-02, streamed progress, failure degradation, the respawn path, and the recorded f16-predicate mutation proof
- `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts` — new: 11 cases driving the real `maia-worker.js` via `node:vm`
- `frontend/src/lib/engine/maiaWorkerHost.ts` — `spawn()`/`ensureSpawned()` restructured for the async-at-the-seam runtime fetch; new `constructWorker()`; `spawnInFlight`/`spawnGeneration` state; `respawnPinnedToWasm()`'s unconditional `resetEngineAssetForRefetch('ort-runtime')`; `handleMessage`'s `ready` branch also marks `'ort-runtime'` done
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` — mocks `ortRuntimeSource` with a synchronous-thenable default (25 pre-existing tests unchanged); adds 9 new cases for the async spawn seam and both-surfaces proof
- `frontend/public/maia/maia-worker.js` — `initSession`/`initWasmOnlySession` take an explicit `chosenBackend` instead of probing; `wasmBinary` set/cleared around `create()`; message-protocol doc comment updated
- `frontend/public/maia/README.md` — new "Runtime binary ownership" section: the empirical `wasmBinary` gate finding and the confirmed bundle-to-binary pairing
- `frontend/src/lib/engine/engineAssetProgress.ts` — `'ort-runtime'` added to `EngineAssetId`/`ALL_ENGINE_ASSETS`/`ENGINE_ASSET_FALLBACK_BYTES`/`ENGINE_ASSET_LABEL`; new `ORT_RUNTIME_BYTES_FALLBACK` constant
- `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts` — updated for the three-asset `requiredEngineAssets()`/`engineGateRequired()` contract; new three-asset denominator, monotonicity, and `resetEngineAssetForRefetch('ort-runtime')` coverage
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` — every hardcoded two-asset percent/MB assertion updated to the new 66,459,075-byte three-asset total; new `describe.each(['bots','analysis'])` block proving both mounts share the denominator, keep distinct copy, and gate on all three
- `frontend/src/hooks/__tests__/useBotGame.test.ts` / `frontend/src/pages/__tests__/Analysis.test.tsx` — `[Rule 1]` seen-flag priming extended to all three assets (see Deviations)

## Decisions Made

See `key-decisions` in frontmatter: the empirical (not documentation-based) resolution of Task 1's gate, the deliberate smaller-fallback choice for `ORT_RUNTIME_BYTES_FALLBACK`, the separate non-memoised `fetchWasmOnlyOrtRuntime()` export, the unconditional `ort-runtime` reset on respawn, and the two-`.then()`-composition bug found and fixed mid-Task-2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Composing an extra `.then()` on `fetchWasmOnlyOrtRuntime()`'s return converted the mode='wasm' respawn's test double into a real microtask, breaking 3 pre-existing tests**
- **Found during:** Task 2, first test run after writing `spawn()`
- **Issue:** To unify `ensureOrtRuntime()`'s `Promise<{backend, buffer}>` shape with `fetchWasmOnlyOrtRuntime()`'s `Promise<ArrayBuffer | null>` shape into one `runtimePromise` variable, the initial implementation composed `fetchWasmOnlyOrtRuntime().then((buffer) => ({backend: 'wasm', buffer}))` before the single `.then()` call `spawn()` makes on it. The synchronous-thenable test double's `.then()` implementation invokes its callback immediately BUT itself returns a real `Promise.resolve(result)` — composing a second `.then()` on top of that therefore reintroduces a genuine microtask hop, silently, for the `mode: 'wasm'` respawn path only.
- **Fix:** Branch on `mode` BEFORE calling `.then()` at all — two separate `.then()` call sites, each directly on the mocked function's own return value, so the synchronous-thenable contract holds for both branches.
- **Files modified:** `frontend/src/lib/engine/maiaWorkerHost.ts`
- **Verification:** `webgpu-unavailable terminates worker #1...`, `hands the dying worker's model bytes...`, and `never re-probes WebGPU after it has failed once...` — all 3 pre-existing tests failed with the composed-`.then()` version, passed after the fix.
- **Committed in:** `5c7e934db` (Task 2)

**2. [Rule 1 - adjacent test breakage caused directly by this task's own change] Task 3's third required asset broke 59 tests in `useBotGame.test.ts` and would have broken the equivalent `Analysis.test.tsx` cases**
- **Found during:** Task 3, plan-level full-suite verification
- **Issue:** Both files' outer `beforeEach` primes the engine-asset seen flags via the real production `markEngineAssetReady()` path so the WHOLE file defaults to "warm cache, no gate" — previously priming only `'maia-model'`/`'stockfish-wasm'`. With `'ort-runtime'` now a third `engineGateRequired()` member, that priming was incomplete, so the gate stayed required (`live` stuck `false`) for every test in `useBotGame.test.ts` that assumed the default warm-cache state — a direct, necessary consequence of Task 3's own change to `requiredEngineAssets()`, not a pre-existing defect.
- **Fix:** Added `markEngineAssetReady('ort-runtime')` alongside the two existing calls in both files' outer `beforeEach`, plus the four nested "engine-ready-gate" tests that explicitly re-prime a clean subset to exercise the gate predicate itself.
- **Files modified:** `frontend/src/hooks/__tests__/useBotGame.test.ts`, `frontend/src/pages/__tests__/Analysis.test.tsx`
- **Verification:** Full suite green after the fix — 246 test files / 3795 tests (up from 59 failing).
- **Committed in:** `bf7c0c8d7` (separate deviation-fix commit, after Task 3's own commit `b64524f7a`)

---

**Total deviations:** 2 auto-fixed (1 bug found and fixed within a task before its own commit, 1 adjacent-test-breakage fix committed separately after the introducing task)
**Impact on plan:** Both fixes were necessary consequences of this plan's own changes, not scope creep. No shipped behavior beyond what the plan specified.

## Issues Encountered

None beyond the two deviations documented above.

## User Setup Required

None — no external service configuration required.

## Verification

Task 1 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/ortRuntimeSource.test.ts` — 22/22 pass (grew from an initial 3 test-authoring mistakes in the CR-02/fallback-total tests — fixed by matching the real precedent's `contentLength: null` construction instead of the `??`-defaulted `makeImmediateResponse` helper).

Task 2 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/maiaWorkerHost.test.ts src/lib/engine/__tests__/maiaWorkerScript.test.ts` — 45/45 pass (34 + 11).

Task 3 `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/engineAssetProgress.test.ts src/components/bots/__tests__/EngineReadyGate.test.tsx` — 61/61 pass (33 + 28).

Plan-level `<verification>`: `cd frontend && npm run lint && npm run knip && npm run build && npm test -- --run` — lint clean, knip clean (0 unused exports), build clean (`tsc -b` + `vite build`, confirming the 'ort-runtime' type gap deliberately left open after Tasks 1-2 closes cleanly), full suite **246 test files / 3795 tests passed** (after the Deviation 2 fix — see above; no `Train.guestGate.test.tsx` flake observed on this run).

Invariant re-checks (all pass, per the full green run):
- D-13: `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#D-13: a device without WASM SIMD issues ZERO runtime-fetch calls` — zero `ensureOrtRuntime`/`fetchWasmOnlyOrtRuntime` calls, zero Workers constructed.
- G-213-8: the pre-existing `hands the dying worker's model bytes to the wasm replacement as a TRANSFER...` and `does NOT reset the progress bar when the replacement was handed the bytes...` tests both still pass unmodified.
- G-213-19: `says the engine is starting once the last byte lands but the worker is not ready yet` — updated to require all three assets' bytes, still passes.
- G-213-19b: unaffected — `requiredEngineAssets()` remains unconditional, no blend branch introduced.
- G-213-34: `describe.each(['bots','analysis'])` new block proves two mounts, distinct copy, one gate, one progress element each.

## Next Phase Readiness

- Tasks 1-3's automated proof is complete: the empirical `wasmBinary` gate cleared for both builds, exactly one runtime fetch per page load (mutation-proven memoisation), accurate three-asset accounting (monotonic across the estimate-to-exact transition), the D-13 SIMD gate still precedes every fetch, CR-02 holds for the new id, graceful degradation on every failure mode, the webgpu->wasm respawn requests the correct different binary, and the worker script's own `importScripts`/`numThreads`/`wasmBinary` contract is proven end-to-end via `node:vm`.
- **Task 4 is NOT executed — a `checkpoint:human-verify` with `gate="blocking-human"` remains.** This is the gap's actual closing acceptance check (a numeric Chrome-vs-Brave DevTools Network-tab comparison across BOTH surfaces), and per this plan's `autonomous: false` frontmatter it is never auto-approved by an executor in any mode. The dev server for this worktree is running at **http://localhost:5180/**, proxying `/api` to the already-running shared backend on `:8000` (which serves the shared dev DB) — ready for the human check described in the plan's Task 4 `<how-to-verify>`.
- G-213-35 (both halves — 213-08's shared Stockfish source and this plan's main-thread ORT runtime ownership) can be marked resolved once Task 4's cold-cache cross-browser check confirms the accounted totals match DevTools' real transferred totals, on both bot play and the analysis board.
- The `CHANGELOG.md` entry for this fix is due when this work merges to `main`, alongside 213-08's entry — not added by this plan (deferred to merge time per `docs/git-workflow.md`, matching 213-08-SUMMARY.md's own note).

## Self-Check: PASSED

- `frontend/src/lib/engine/ortRuntimeSource.ts` — FOUND, contains `ensureOrtRuntime`, `fetchWasmOnlyOrtRuntime`, `resetOrtRuntimeSourceForTests`
- `frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts` — FOUND, 22 test cases
- `frontend/src/lib/engine/maiaWorkerHost.ts` — FOUND, contains `constructWorker`, `spawnInFlight`, `spawnGeneration`, imports `ensureOrtRuntime`/`fetchWasmOnlyOrtRuntime`
- `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts` — FOUND, 11 test cases
- `frontend/public/maia/maia-worker.js` — FOUND, `initSession(chosenBackend, ...)` signature, no `navigator.gpu` reference outside comments
- `frontend/src/lib/engine/engineAssetProgress.ts` — FOUND, `'ort-runtime'` in `EngineAssetId`/`ALL_ENGINE_ASSETS`/`ENGINE_ASSET_FALLBACK_BYTES`/`ENGINE_ASSET_LABEL`
- Commit `fb45bb684` — FOUND in `git log --oneline --all`
- Commit `5c7e934db` — FOUND in `git log --oneline --all`
- Commit `b64524f7a` — FOUND in `git log --oneline --all`
- Commit `bf7c0c8d7` — FOUND in `git log --oneline --all`
- `npm run build` — PASSED (tsc -b clean, vite build clean)
- Full test suite — 246 files / 3795 tests PASSED

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-29 (Tasks 1-3; Task 4 checkpoint pending human verification)*
