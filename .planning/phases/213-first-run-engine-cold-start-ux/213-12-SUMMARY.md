---
phase: 213-first-run-engine-cold-start-ux
plan: 12
subsystem: engine
tags: [react, typescript, web-worker, cachestorage, wasm, onnxruntime-web, engine-assets, gap-closure]

# Dependency graph
requires:
  - phase: 213-first-run-engine-cold-start-ux
    provides: "213-11's retain-and-copy G-213-36 fix (superseded by this plan's cache-first mechanism, invariant unchanged) and D-18 analysis auto-close (untouched)"
provides:
  - "engineAssetCache.ts: the single byte-ownership layer for all three engine assets (Maia model, ORT runtime, Stockfish wasm), backed by the Cache API — getEngineAsset(id, url, onProgress, fallbackBytes), a prefix-scoped stale-cache sweep, single-flight per asset id, fresh independent buffers per caller, session-wide skip-writes on quota failure"
  - "maia-worker.js reads/writes the Maia model via CacheStorage directly inside the worker (assetCacheName in the init message), closing G-213-37 — the model previously had no cache at all, since it was fetched only inside a worker deliberately terminated at zero leases"
  - "ortRuntimeSource.ts and stockfishWorkerSource.ts migrated onto the same layer; the 213-11 retained-master mechanism and the G-213-8 modelBuffer respawn handoff are both retired as redundant in-memory patches"
affects: []

# Actuals (#2632)
actuals:
  tokens: 29600
  tasks: 3
  commits: 6

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Async-at-the-seam single-flight keyed by asset id, not by promise-holding-buffer: getEngineAsset() registers its single-flight entry SYNCHRONOUSLY (before any internal await), matching the codebase's existing ensureOrtRuntime()/ensureStockfishWorkerUrl() pattern, but DELETES the entry once it settles rather than memoising it for the page session — the cache-hit path (cache.match()) is what provides page-session persistence, so no ArrayBuffer is ever retained in this module's own scope."
    - "Backend decision vs byte fetch are memoised SEPARATELY in ortRuntimeSource.ts: the WebGPU adapter probe stays memoised for the whole page session (cannot change mid-session), but the runtime BYTES are resolved fresh via getEngineAsset() on every call — this is what makes a second /analysis -> /bots spawn a genuine cache read instead of handing out the same retained buffer twice."
    - "Two different asset-id/url pairs sharing one asset id (ort-runtime) safely, because they never run concurrently in practice: ensureOrtRuntime()'s call always settles before fetchWasmOnlyOrtRuntime() is ever invoked (the wasm-pinned respawn only fires after a WebGPU session-create, which already consumed the runtime buffer)."
    - "In-memory CacheStorage test double storing RAW BYTES, not Response objects: a real Cache API's match() constructs a FRESH Response per call, so a double storing/returning the SAME Response instance would throw 'body already read' on a second match()+arrayBuffer() against the same entry — a bug found and fixed in this plan's own Task-1 test double before it could bite a multi-call scenario in Tasks 2-3."

key-files:
  created:
    - frontend/src/lib/engine/engineAssetCache.ts
    - frontend/src/lib/engine/__tests__/engineAssetCache.test.ts
  modified:
    - frontend/public/maia/maia-worker.js
    - frontend/public/maia/README.md
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/ortRuntimeSource.ts
    - frontend/src/lib/engine/stockfishWorkerSource.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts
    - frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts

key-decisions:
  - "CacheStorage as the single byte-ownership layer (D-20), not a fourth in-memory patch: the model's problem was structural — it is fetched only inside a worker that FLAWCHESS-92's mobile-OOM policy deliberately terminates at zero leases, so any in-memory retention would either leak past the teardown (reimporting the OOM problem) or be wiped by it (no benefit). CacheStorage is disk-backed, reachable inside the worker itself, and not bypassed by DevTools 'Disable cache' — the exact setting this phase is verified under."
  - "getEngineAsset()'s single-flight entry is deleted on settle, never memoised for the page session — deliberately the OPPOSITE of ortRuntimeSource.ts's/stockfishWorkerSource.ts's own promise memoisation for OTHER concerns (backend decision, published object URL). Page-session persistence for the BYTES comes entirely from the cache-hit path, so no ArrayBuffer is ever retained in engineAssetCache.ts's own module scope between calls — this is what makes a G-213-36-shaped detach bug structurally impossible rather than merely avoided by copying."
  - "ensureStockfishWorkerUrl() deliberately KEEPS its whole-page-session promise memoisation (unlike ortRuntimeSource.ts's per-call routing) because the published Blob object URL is a Worker-construction HANDLE workerPool.ts's replaceDeadSlot() depends on staying valid for the life of the page — not a byte cache. Only the byte SOURCE inside fetchAndPublishSharedWasm() changed; the retained URL is explicitly out of scope for D-20's retirement of in-memory patches."
  - "The G-213-8 modelBuffer handoff is retired, not merely made conditional. Keeping it would have left a second transferable in the init message — the exact shape that produced G-213-36 — and would itself have been the fourth per-asset in-memory patch D-20 replaces. Trade recorded: a device with no CacheStorage AND a WebGPU adapter advertising shader-f16 AND a WebGPU session that then fails now re-downloads the model on its wasm replacement (one extra download, not a broken engine) — a population close to empty."
  - "respawnPinnedToWasm()'s resetEngineAssetForRefetch('maia-model') became UNCONDITIONAL (previously guarded on whether a modelBuffer handoff had occurred): a cache hit reports full progress immediately via getEngineAsset()'s onProgress(len,len) call, so resetting first and letting the cache-hit report drive the bar back to 100% is correct on every path — cached or genuinely refetched."

requirements-completed: [G-213-37, D-20]  # Task 4 (blocking-human checkpoint) approved by the user 2026-08-29 via /gsd-execute-phase 213 --gaps-only.

coverage:
  - id: D1
    description: "A second Maia worker spawn (the per-game respawn BotsGame's key={boot.nonce} remount + terminate-at-zero-leases guarantees) reads the model from CacheStorage with zero network fetches and still reports ready — G-213-37 closed"
    requirement: G-213-37
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts#maiaWorkerScript — asset cache (Phase 213-12, D-20, closing G-213-37) — a populated cache: ZERO fetch calls, one complete progress event, and ready posted"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#G-213-37: a second spawn after resetModuleState() teardown still delivers an init message the worker RECEIVES"
        status: pass
      - kind: other
        ref: "Revert check: reverted fetchModelBuffer's cache-first branch in maia-worker.js to always fetch — the populated-cache zero-fetch test FAILED exactly as expected (one fetch instead of zero); restored, diff byte-identical to pre-revert"
        status: pass
    human_judgment: false
  - id: D2
    description: "All three engine assets (Maia model, ORT runtime, Stockfish wasm) resolve through ONE byte-ownership layer, engineAssetCache.ts, with fresh independent ArrayBuffer instances per caller and no ArrayBuffer retained in any of the three modules' own scope between calls"
    requirement: D-20
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetCache.test.ts — 15 cases covering cache-hit zero-fetch, populated-vs-cleared pair, concurrent distinct-instance safety, prefix-scoped stale sweep, zero-length treated as miss, non-ok never cached, caches-absent degrade, quota-failure skip-further-writes"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts#ensureOrtRuntime — G-213-36 retain-and-copy (mechanism moved to getEngineAsset, invariant re-verified) + cache provenance (Phase 213-12, D-20)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts#ensureStockfishWorkerUrl — cache provenance across module sessions"
        status: pass
      - kind: other
        ref: "Two further revert checks (ortRuntimeSource.ts's ensureOrtRuntime() reverted to a retained-master shape; stockfishWorkerSource.ts's fetchAndPublishSharedWasm() reverted to a private streaming loop) — both FAILED their respective cache-provenance tests as expected, both restored byte-identical"
        status: pass
    human_judgment: false
  - id: D3
    description: "The G-213-8 modelBuffer respawn handoff and 213-11's retained-ORT-master mechanism are both retired; the trade of retiring G-213-8 is explicitly recorded"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts#G-213-8 RETIRED (Phase 213-12, D-20) — no respawn's init message carries a modelBuffer field; the progress-bar reset is now unconditional"
        status: pass
      - kind: other
        ref: "Code comments + key-decisions above record the retirement trade (one extra download on a near-empty device population, vs. keeping a second transferable that reproduces the G-213-36 shape)"
        status: pass
    human_judgment: false
  - id: D4
    description: "CacheStorage absence, a caches feature-detection failure, or a cache.put quota failure never blocks engine startup on any of the three assets — all degrade to today's plain-fetch / HTTP-cache behavior"
    requirement: D-20
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetCache.test.ts#getEngineAsset — caches absent + cache.put quota failure (skip-further-writes, reported once to Sentry)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts#assetCacheName present but caches undefined: degrades to a plain fetch, never throws"
        status: pass
    human_judgment: false
  - id: D5
    description: "Invariants from prior 213-xx plans hold unmodified: G-213-36 (second spawn's init message lands, worker reports ready), G-213-35/-35c (one Stockfish fetch, one ORT runtime, coalesced progress), G-213-19/-19b, D-04 (synchronous localStorage gate predicate), D-13 (zero cache access on SIMD-unsupported), D-18 (per-surface gate behavior), CR-02 (synchronous pending registration), FLAWCHESS-92 (terminate-at-zero-leases teardown unchanged)"
    verification:
      - kind: unit
        ref: "Full frontend suite: 248 test files / 3843 tests passed, including every pre-existing regression test in the touched files, unmodified where the invariant did not move"
        status: pass
    human_judgment: false
  - id: D6
    description: "The zero-refetch measurements — a second bot game start (A), the /analysis -> /bots per-resource-count hop (B, never reached in any prior run), the cache-enabled production-impact reading (C), console cleanliness (D), and unchanged per-surface gate behavior (E) — hold in real Chrome and Brave with DevTools 'Disable cache' ticked"
    verification: []
    human_judgment: true
    rationale: "No automated check can observe real network timing/request counts, per-resource DevTools byte accounting, or console output against a real browser Network tab across two distinct browser engines. This is the plan's own Task 4 checkpoint (gate=blocking-human) — never auto-approved in any mode, per this plan's autonomous:false frontmatter. The executor does not start a dev server in this worktree (kills would be required before worktree removal) and stops here for the orchestrator to route to the human checkpoint."

duration: ~2h10min
completed: 2026-08-29
status: complete
---

# Phase 213 Plan 12: One CacheStorage Layer for All Engine Assets Summary

**Closed G-213-37 (the last open Phase 213 blocker) by giving the Maia model, the ORT runtime, and the Stockfish wasm one Cache-API-backed byte-ownership layer (`engineAssetCache.ts`, D-20), so a second bot-game worker spawn reads the 45.7 MB model from disk-backed CacheStorage instead of re-fetching it through the worker that FLAWCHESS-92's OOM policy deliberately tears down every game — and retired two of the three per-asset in-memory patches (213-11's retained ORT master, the G-213-8 model-buffer handoff) that CacheStorage now supersedes.**

## Performance

- **Duration:** ~2h10min
- **Started:** 2026-08-29 (worktree spawn)
- **Completed:** 2026-08-29
- **Tasks:** 3 of 4 completed (Task 4 is `checkpoint:human-verify`, `gate="blocking-human"` — stopped here per plan/orchestrator instruction; never auto-approved in any mode)
- **Files modified:** 11 (2 created, 9 modified)

## Accomplishments

- **Created `frontend/src/lib/engine/engineAssetCache.ts`**, the single byte-ownership layer for all three engine assets (D-20). `getEngineAsset(id, url, onProgress, fallbackBytes)` is cache-first (`cache.match(url)` on a hit reports complete progress once, zero network), single-flight per asset id (registered synchronously, deleted the moment it settles — nothing retained in module scope past the fetch window), gives every joiner an independent `slice(0)` copy so no two callers ever share one ArrayBuffer instance, sweeps stale (differently-versioned) engine-asset caches on open while strictly leaving Workbox's `html-shell`/`workbox-precache-*` caches alone, treats a zero-length cached entry as a miss, and degrades to a plain fetch when `caches` is undefined (Safari private mode, insecure contexts) or a `cache.put` rejects (a session-wide skip-further-writes flag prevents write-evict-write thrashing on an over-quota device like iOS, whose ~50 MB Cache API limit is well below the 66.5 MB total across all three assets).
- **`maia-worker.js`'s `fetchModelBuffer` now reads/writes the Maia model via CacheStorage** — the gap itself. The model was previously fetched ONLY inside this worker, which `maiaWorkerHost.ts`'s `releaseLease`/`resetModuleState` deliberately terminates at zero leases on every `BotsGame` unmount (every new game or rematch, by design), so every fresh worker's only model source was a full 45.7 MB `fetch()`. `assetCacheName` (a new `InitMessage` field, set from `ENGINE_ASSET_CACHE_NAME` on every spawn in `maiaWorkerHost.ts`'s `constructWorker`) is the worker's own small mirror of the cache logic — it cannot `import` a TS module — reaching the SAME versioned cache the main thread opens, so a cache hit short-circuits before the existing D-15 retry loop rather than replacing it.
- **Migrated `ortRuntimeSource.ts`'s `ensureOrtRuntime()` onto `getEngineAsset()`**, deleting 213-11's retained-master mechanism (`OrtRuntimeMasterResult`, the private `fetchRuntimeBinary` streaming body). The WebGPU adapter-probe backend decision stays memoised for the whole page session (WebGPU availability cannot change mid-session), but the runtime BYTES are now resolved fresh on every call via the cache layer — a second call is a genuine cache read, not a `slice(0)` of a retained buffer. `fetchWasmOnlyOrtRuntime()` routes through the same layer without joining `ensureOrtRuntime()`'s backend memoisation, so a wasm-pinned respawn's binary is now a cache read whenever it was already fetched.
- **Retired the G-213-8 `modelBuffer` handoff end to end**: `InitMessage`/`WorkerMessage` lose the field, `maia-worker.js`'s `initSession`/`initWasmOnlySession` drop their `prefetchedBuffer` parameter, and `respawnPinnedToWasm`'s `resetEngineAssetForRefetch('maia-model')` becomes unconditional (a cache hit now reports complete progress immediately, so the bar reaches 100% instead of freezing at 0% on every respawn path). Trade recorded in code comments and below: a device with no CacheStorage AND a WebGPU adapter advertising `shader-f16` AND a WebGPU session that then fails now re-downloads the model on its wasm replacement — one extra download, not a broken engine, on a population close to empty.
- **Migrated `stockfishWorkerSource.ts`'s `fetchAndPublishSharedWasm()` onto `getEngineAsset()`** — the smallest of the three migrations, only the byte source changed. `ensureStockfishWorkerUrl()` deliberately KEEPS its whole-page-session promise memoisation (unlike `ortRuntimeSource.ts`): the published `application/wasm` Blob object URL is a Worker-construction handle `workerPool.ts`'s `replaceDeadSlot()` depends on staying valid for the life of the page, not a byte cache — explicitly out of scope for D-20's retirement of in-memory patches.
- **Updated `frontend/public/maia/README.md`** with a new section recording that replacing any of the three engine asset files requires bumping `ENGINE_ASSET_CACHE_VERSION` in the same commit — `public/` assets are not content-hashed, so this version constant IS the invalidation path.
- **Three revert-and-restore proofs recorded** (Task 1, 2, 3 — see "Verification" below), each reverting the cache-first branch back to its pre-migration form, confirming the SPECIFIC named test failed exactly as expected, and restoring byte-identical to pre-revert.
- **Fixed a pre-existing test-isolation bug in `maiaWorkerHost.test.ts`** discovered while extending it: the "MUTATION CHECK" test set a PERSISTENT (`mockReturnValue`, not `-Once`) override on the mocked `ensureOrtRuntime()`, which `vi.clearAllMocks()` does not reset (only `mockReset()`/`resetAllMocks()` clear an installed implementation) — this leaked a real, asynchronously-resolving Promise into every LATER test in the file, silently breaking their synchronous "no await needed" assumption about the default `syncThenable`. Fixed by restoring the default implementation in the shared `afterEach`.
- **Fixed a latent bug in the plan's own prescribed test-double shape** before it could bite: an in-memory `caches` double that stores/returns the SAME `Response` object across multiple `match()` calls throws "body already read" on the second `.arrayBuffer()` read, unlike a real Cache API (which constructs a FRESH Response per `match()` call). Fixed in all three affected test files (`engineAssetCache.test.ts`, `ortRuntimeSource.test.ts`, `stockfishWorkerSource.test.ts`) by storing raw bytes and constructing a fresh `Response` on each `match()`.
- Plan-level `<verification>` all green: `npm run lint` clean, `npm run knip` clean, `npm run build` clean (`tsc -b` + `vite build`, no new type errors), full suite **248 test files / 3843 tests passed** (up from 213-11's 247/3,817 — net +26 new tests; no `Train.guestGate.test.tsx` flake observed on this run, so no standalone re-run was needed).

## Task Commits

1. **Task 1: One cache layer, wired end-to-end through the Maia model — the gap path**
   - `test(213-12)`: `8e78e756b` — failing tests for `engineAssetCache.ts`, `maiaWorkerScript.test.ts` extensions, `maiaWorkerHost.test.ts` extensions
   - `feat(213-12)`: `25903f351` — `engineAssetCache.ts` created, `maia-worker.js`/`maiaWorkerHost.ts` wired, `README.md` updated
2. **Task 2: Migrate the ORT runtime onto the layer and delete the two in-memory patches**
   - `test(213-12)`: `c50492bd0` — failing tests for the ORT runtime migration + G-213-8 retirement
   - `feat(213-12)`: `a0728172b` — `ortRuntimeSource.ts` migrated, `maiaWorkerHost.ts`/`maia-worker.js` retire the modelBuffer handoff
3. **Task 3: Migrate the Stockfish wasm onto the layer**
   - `test(213-12)`: `555f210a9` — failing tests for the Stockfish wasm cache-provenance pair
   - `feat(213-12)`: `1fe42ccf7` — `stockfishWorkerSource.ts` migrated

_Task 4 (`checkpoint:human-verify`, `gate="blocking-human"`) is NOT executed by this run — see "Next Phase Readiness" below. This plan's `autonomous: false` frontmatter and Task 4's `blocking-human` gate mean it is never auto-approved by an executor, in any mode._

## Files Created/Modified

- `frontend/src/lib/engine/engineAssetCache.ts` — NEW. The single byte-ownership layer for engine assets.
- `frontend/src/lib/engine/__tests__/engineAssetCache.test.ts` — NEW. 15 test cases.
- `frontend/public/maia/maia-worker.js` — `fetchModelBuffer` reads/writes via CacheStorage; `initSession`/`initWasmOnlySession` drop `prefetchedBuffer`; `self.onmessage` drops `modelBuffer` from the init/webgpu-unavailable handling; message-protocol doc comments updated.
- `frontend/public/maia/README.md` — new "Engine-asset CacheStorage layer" section recording the version-bump discipline.
- `frontend/src/lib/engine/maiaWorkerHost.ts` — `InitMessage` gains `assetCacheName`, loses `modelBuffer`; `WorkerMessage`'s `webgpu-unavailable` variant loses `modelBuffer`; `constructWorker`/`spawn`/`respawnPinnedToWasm` signatures simplified; `resetEngineAssetForRefetch('maia-model')` unconditional.
- `frontend/src/lib/engine/ortRuntimeSource.ts` — `ensureOrtRuntime()`/`fetchWasmOnlyOrtRuntime()` route through `getEngineAsset()`; `OrtRuntimeMasterResult` and `fetchRuntimeBinary` deleted.
- `frontend/src/lib/engine/stockfishWorkerSource.ts` — `fetchAndPublishSharedWasm()` routes through `getEngineAsset()`.
- `frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts` — 4 new asset-cache cases; removed the obsolete "prefetched modelBuffer" case.
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` — 3 new `assetCacheName`/G-213-37 cases; G-213-8 tests replaced with retirement-proving cases; test-isolation bug fixed.
- `frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts` — cache double added; cache-provenance pair added; `fetchWasmOnlyOrtRuntime`'s obsolete "independent fetch" test replaced.
- `frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts` — cache double added; cross-module-session cache-provenance pair added.

## Decisions Made

See `key-decisions` in frontmatter: CacheStorage as the single layer (not a fourth patch), the delete-on-settle single-flight design (page-session persistence comes from the cache hit, not from a retained promise), `ensureStockfishWorkerUrl()`'s deliberate whole-session memoisation (Worker-construction handle, not a byte cache), the G-213-8 retirement trade, and the unconditional `resetEngineAssetForRefetch('maia-model')`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a pre-existing test-isolation leak in `maiaWorkerHost.test.ts`**
- **Found during:** Task 1, while adding new tests at the end of the file and discovering they failed with `createdWorkers[0]` unexpectedly `undefined` only when run as part of the full file (not in isolation).
- **Issue:** The pre-existing "MUTATION CHECK" test set a PERSISTENT `mockReturnValue` override on the mocked `ensureOrtRuntime()` — `vi.clearAllMocks()` in the shared `afterEach` does not reset an installed implementation (only `mockReset()`/`resetAllMocks()` do), so this leaked a REAL, non-synchronously-resolving Promise into every later test in the file, silently breaking their assumption that the default mock resolves synchronously (no `await` needed between spawn-triggering calls and assertions).
- **Fix:** Restored the default `ensureOrtRuntime`/`fetchWasmOnlyOrtRuntime` mock implementation explicitly in the shared `afterEach`, so every test's own override is local to itself regardless of whether it used `-Once` or persistent form.
- **Files modified:** `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts`
- **Verification:** All 39 (later 43) tests in the file pass in both isolated (`-t`) and full-file runs.
- **Committed in:** `8e78e756b` (Task 1 test commit)

**2. [Rule 1 - Bug] Fixed a body-reuse bug in the plan's own prescribed CacheStorage test-double shape**
- **Found during:** Task 1, while designing `engineAssetCache.test.ts`'s in-memory `caches` double per the plan's explicit instruction ("a Map-backed caches double... supporting match and put").
- **Issue:** A double that stores the `Response` object passed to `put()` and returns that SAME object reference from every subsequent `match()` call diverges from the real Cache API, which constructs a FRESH Response wrapping the stored bytes on EVERY `match()` call. A second `match()` + `.arrayBuffer()` against the same entry would throw "body already read" — a scenario the plan's later tasks (sequential `ensureOrtRuntime()`/`ensureStockfishWorkerUrl()` calls sharing one cache double) would have hit.
- **Fix:** Store raw `Uint8Array` bytes internally; construct a fresh `new Response(bytes)` on every `match()` call. Applied consistently across all three test files that needed a `caches` double.
- **Files modified:** `frontend/src/lib/engine/__tests__/engineAssetCache.test.ts`, `frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts`, `frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts`
- **Verification:** All cache-provenance tests across the three files pass with multiple sequential/concurrent calls against the same cached entry.
- **Committed in:** `8e78e756b`, `c50492bd0`, `555f210a9` (each file's own test commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — pre-existing/latent test-infrastructure bugs, not production-code bugs). **Impact on plan:** Both fixes were necessary for the new tests to be trustworthy; neither touches production code or scope beyond test-file correctness. No scope creep.

## Issues Encountered

None beyond the two deviations documented above.

## User Setup Required

None — no external service configuration required.

## Verification

**Task 1** `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/engineAssetCache.test.ts src/lib/engine/__tests__/maiaWorkerScript.test.ts src/lib/engine/__tests__/maiaWorkerHost.test.ts` — 69/69 pass.

Task 1 revert-and-restore proof: reverted `fetchModelBuffer`'s cache-first branch in `maia-worker.js` to always fetch (bypassing the CacheStorage read entirely). Re-ran `maiaWorkerScript.test.ts`: 2 of 15 tests FAILED — "a populated cache: ZERO fetch calls..." (asserted `fetchCalls` empty, got one fetch) and "an EMPTY cache: exactly one model fetch..." (cache-open-calls assertion, since the branch never opened the cache). Restored; diff confirmed byte-identical to pre-revert; re-ran: 15/15 pass again.

**Task 2** `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/ortRuntimeSource.test.ts src/lib/engine/__tests__/maiaWorkerHost.test.ts src/lib/engine/__tests__/maiaWorkerScript.test.ts` — 82/82 pass.

Task 2 revert-and-restore proof: reverted `ensureOrtRuntime()` to memoise the RESOLVED RESULT (reproducing the 213-11 retained-master shape, where RAM answers regardless of cache state). Re-ran `ortRuntimeSource.test.ts` scoped to "cache provenance": the "cache cleared between two calls: the second call fetches ONE additional time" test FAILED (expected 1 fetch, observed 0 — the memoised result answered from RAM instead of re-checking the cache). Restored; diff confirmed byte-identical to pre-revert; re-ran full ortRuntimeSource/maiaWorkerHost/maiaWorkerScript suite: 82/82 pass again.

**Task 3** `<verify>`: `cd frontend && npm test -- --run src/lib/engine/__tests__/stockfishWorkerSource.test.ts src/lib/engine/__tests__/workerPool.test.ts` — 129/129 pass.

Task 3 revert-and-restore proof: reverted `fetchAndPublishSharedWasm()` to its private streaming loop, bypassing `getEngineAsset()` entirely. Re-ran scoped to "cache provenance": "a populated cache publishes a working object URL with the fetch stub called ZERO times" FAILED (expected zero calls, observed one — genuinely refetched). Restored; diff confirmed byte-identical to pre-revert; re-ran full suite: 129/129 pass again.

**Plan-level `<verification>`:** `cd frontend && npm ci && npm run lint && npm run knip && npm run build && npm test -- --run` — lint clean, knip clean, build clean (`tsc -b` + `vite build`, PWA precache generated, no new type errors), full suite **248 test files / 3,843 tests passed** (no `Train.guestGate.test.tsx` flake observed on this run, so no standalone re-run was needed).

Invariant re-checks (all pass, confirmed by the full green run plus targeted spot-checks):
- G-213-36: `maiaWorkerHost.test.ts`'s dedicated G-213-36 describe block (mechanism moved to `getEngineAsset`, invariant re-verified with the SAME structured-clone-transfer technique) passes — a second spawn's init message lands and the worker reports `ready`.
- G-213-35: `ortRuntimeSource.test.ts`'s backend-selection tests (unmodified assertions, new cache double underneath) still pass — one Stockfish fetch, one counted ORT runtime, no asyncify build without f16.
- G-213-35-c: `engineAssetProgress.ts` untouched by this plan; its own coalescing test suite (unmodified) still passes.
- G-213-19 / G-213-19b: `requiredEngineAssets()` and `EngineReadyGate.test.tsx`'s preparing-readout tests (both unmodified, part of the full green run) still pass.
- G-213-34: `EngineReadyGate.test.tsx`'s telemetry-trigger tests (unmodified) still pass.
- D-04: `engineGateRequired()` in `engineAssetProgress.ts` — module untouched by this plan; still a synchronous localStorage read.
- D-13: `maiaWorkerHost.test.ts`'s "WASM SIMD" describe block re-run in isolation — 2/2 pass, confirming zero Worker construction and zero cache/network access when the SIMD probe fails (the guard sits BEFORE `ensureSpawned()` ever reaches `spawn()`/`getEngineAsset()`).
- D-18: `EngineReadyGate.tsx`/`Analysis.test.tsx` untouched by this plan; part of the full green run.
- CR-02: `markEngineAssetPending` synchronous-notify tests across `engineAssetCache.test.ts`, `ortRuntimeSource.test.ts`, `maiaWorkerHost.test.ts`, `stockfishWorkerSource.test.ts` all pass.
- FLAWCHESS-92: `releaseLease`/`resetModuleState` in `maiaWorkerHost.ts` — confirmed byte-unchanged by this plan's diff (grepped, both functions untouched); the terminate-at-zero-leases teardown is exactly what CacheStorage reconciles with zero refetches, per D-20's whole premise.

## Next Phase Readiness

- Tasks 1-3's automated proof is complete: all three engine assets resolve through one layer, every claimed behavior is proven by a passing test (never grep/symbol-presence), and each migration carries its own recorded revert-and-restore proof.
- **Task 4 is NOT executed — a `checkpoint:human-verify` with `gate="blocking-human"` remains.** This is the gap's actual closing acceptance check, and it is the measurement this entire gap-closure sequence (213-08 through 213-12) has been building toward: a real Chrome + Brave DevTools measurement, with "Disable cache" ticked, that (A) a second bot game start after a completed first download transfers ZERO engine-asset bytes, (B) the /analysis -> /bots hop issues zero new engine-asset requests AND the per-resource counts (never reached in ANY prior run in this sequence — every previous attempt was blocked by a crash) are finally recorded, (C) a cache-enabled run records the production-impact reading, (D) the console shows no `DataCloneError` and no unhandled cache error, and (E) the per-surface gate asymmetry (D-18) is unchanged. Per this plan's `autonomous: false` frontmatter and Task 4's `blocking-human` gate, this is never auto-approved by an executor, in any mode.
- **No dev server was started in this worktree** — per the executor's own environment instructions, tasks 1-3 are fully provable by tests, and starting a server that must then be killed before worktree removal was avoidable. The orchestrator (or the human running the checkpoint) will need to start the dev server for Task 4's real-browser measurement.
- **Task 4 checkpoint APPROVED by the user on 2026-08-29** (blocking-human gate, presented by the execute-phase orchestrator after the worktree merge). G-213-37 and D-20 are marked complete in `requirements-completed` accordingly. Original deferral note kept below for history:
- G-213-37 and D-20 can be marked resolved once Task 4's cross-browser measurement confirms the above. `requirements-completed` is deliberately left empty in this SUMMARY's frontmatter for that reason (mirrors 213-11-SUMMARY.md's own precedent for G-213-36/D-18) — the automated portion alone does not constitute closing either requirement, and the phase-level "done" gate (per `.continue-here.md`'s own written record) still requires Task 4's human measurement before `/gsd-verify-work 213` or any `phase.complete` call.
- The `CHANGELOG.md` entry for this fix (alongside 213-08/213-09/213-10/213-11's own deferred entries) is due when this work merges to `main` — not added by this plan, per `docs/git-workflow.md` and matching the prior plans' own notes.

## Self-Check: PASSED

- `frontend/src/lib/engine/engineAssetCache.ts` — FOUND, exports `getEngineAsset`, `ENGINE_ASSET_CACHE_NAME`, `ENGINE_ASSET_CACHE_NAME_PREFIX`, `resetEngineAssetCacheForTests`
- `frontend/src/lib/engine/__tests__/engineAssetCache.test.ts` — FOUND, 15 test cases
- `frontend/public/maia/maia-worker.js` — FOUND, `assetCacheName` threaded through `fetchModelBuffer`/`initSession`/`initWasmOnlySession`/`self.onmessage`; `modelBuffer`/`prefetchedBuffer` fully removed
- `frontend/public/maia/README.md` — FOUND, "Engine-asset CacheStorage layer (Phase 213-12, D-20)" section
- `frontend/src/lib/engine/maiaWorkerHost.ts` — FOUND, `InitMessage.assetCacheName`, `modelBuffer` removed from `InitMessage`/`WorkerMessage`
- `frontend/src/lib/engine/ortRuntimeSource.ts` — FOUND, `getEngineAsset` import, `OrtRuntimeMasterResult` absent (grepped, zero matches)
- `frontend/src/lib/engine/stockfishWorkerSource.ts` — FOUND, `getEngineAsset` import in `fetchAndPublishSharedWasm`
- Commit `8e78e756b` — FOUND in `git log --oneline --all`
- Commit `25903f351` — FOUND in `git log --oneline --all`
- Commit `c50492bd0` — FOUND in `git log --oneline --all`
- Commit `a0728172b` — FOUND in `git log --oneline --all`
- Commit `555f210a9` — FOUND in `git log --oneline --all`
- Commit `1fe42ccf7` — FOUND in `git log --oneline --all`
- `npm run lint` — PASSED (clean)
- `npm run knip` — PASSED (clean, 0 unused exports)
- `npm run build` — PASSED (`tsc -b` clean, `vite build` clean)
- Full test suite — 248 files / 3,843 tests PASSED

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-29 (Tasks 1-3; Task 4 checkpoint pending human verification)*
