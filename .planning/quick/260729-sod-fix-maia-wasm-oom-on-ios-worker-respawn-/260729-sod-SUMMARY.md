---
phase: quick-260729-sod
plan: 01
subsystem: frontend-engine
tags: [maia, onnxruntime-web, web-worker, sentry, caddy, memory]

requires: []
provides:
  - "maia-worker.js respawn protocol: {type:'init', backend?:'wasm'} in, {type:'webgpu-unavailable'} out — no double-loaded ORT runtime on a WebGPU fallback"
  - "frontend/src/lib/maiaWorkerErrors.ts — bounded Sentry classification (oom/load/inference) + maia_failure tag, shared by both Maia worker owners"
  - "frontend/src/lib/engine/maiaWorkerHost.ts — refcounted single-Worker host with lease-based acquire/release and one-in-flight priority dispatch, shared by useMaiaEngine and maiaQueue"
  - "deploy/Caddyfile 30-day cache for /maia/* + /engine/* vendored binaries, no-cache for /maia/maia-worker.js"
affects: [analysis-page, bots-page, maia-engine]

tech-stack:
  added: []
  patterns:
    - "Lease-based worker refcounting (acquireMaiaWorker/release) as the shared-transport pattern for future multi-consumer Web Workers"
    - "Sentry classification-then-context (bounded message + raw text in contexts.maia) instead of embedding variable text in the error message"

key-files:
  created:
    - frontend/src/lib/maiaWorkerErrors.ts
    - frontend/src/lib/maiaWorkerErrors.test.ts
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
  modified:
    - frontend/public/maia/maia-worker.js
    - frontend/src/hooks/useMaiaEngine.ts
    - frontend/src/lib/engine/maiaQueue.ts
    - frontend/src/hooks/useGemSweep.ts
    - deploy/Caddyfile
    - frontend/public/maia/README.md
    - frontend/src/pages/Analysis.tsx

key-decisions:
  - "Classification order is OOM-first: the real FLAWCHESS-92 string matches both the OOM and load regex patterns, and the memory signal is the true cause"
  - "maiaWorkerHost serialises to exactly ONE inference in flight globally, so the worker's result message needs no request-id — ORT can't run two inferences concurrently on one session anyway"
  - "webgpu-unavailable is NOT worker death: it's a transparent respawn (queue/leases survive); onerror and a pre-ready 'error' message ARE worker death (reject everything, fire onFatal, lease persists for self-heal on the next call)"
  - "maiaQueue.ts keeps a local leaseReady gate (not the host's own readiness) to preserve its pre-existing same-FEN batching window — calling lease.analyze() eagerly would defeat D-04's dedup-into-one-call optimization"
  - "Cache headers: 30-day public (not immutable — filenames aren't content-hashed and ORT resolves its own wasm/mjs names from wasmPaths) for vendored /maia/* + /engine/*; no-cache for maia-worker.js since it's our source and its protocol just changed"

requirements-completed: [FIX-1-RESPAWN, FIX-2-SENTRY-TAG, FIX-3-SHARED-WORKER, FIX-4-CACHE-HEADERS]

coverage:
  - id: D1
    description: "FIX 2 — distinct, filterable Sentry grouping for Maia worker failures (maiaWorkerErrors.ts, oom-first classification)"
    requirement: FIX-2-SENTRY-TAG
    verification:
      - kind: unit
        ref: "frontend/src/lib/maiaWorkerErrors.test.ts — classifyMaiaWorkerError classifies the real FLAWCHESS-92 OOM string as oom, not load"
        status: pass
    human_judgment: false
  - id: D2
    description: "FIX 1 — maia-worker.js respawns a fresh wasm-pinned worker on WebGPU failure instead of double-loading ORT into the same heap; FLAWCHESS-95 concurrent-analyze race also closed"
    requirement: FIX-1-RESPAWN
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts — 'webgpu-unavailable terminates worker #1 and constructs exactly one wasm-pinned replacement, servicing queued requests'"
        status: pass
    human_judgment: true
    rationale: "Mock Workers never allocate a real WASM heap — the actual OOM-avoidance can only be confirmed on a real device (iPhone Safari /bots, or Chrome DevTools memory profiling on /analysis). Code-level structural proof (single importScripts per initSession() control-flow path) is documented in this SUMMARY but is not itself a device test."
  - id: D3
    description: "FIX 4 — 30-day cache for /maia/* and /engine/*, no-cache for /maia/maia-worker.js"
    requirement: FIX-4-CACHE-HEADERS
    verification:
      - kind: other
        ref: "docker run caddy:2.11.2 caddy adapt --config deploy/Caddyfile — confirmed /maia/maia-worker.js resolves to no-cache and is excluded (not path) from the max-age=2592000 matcher"
        status: pass
    human_judgment: false
  - id: D4
    description: "FIX 3 — one shared, refcounted Maia worker across /analysis (chart + gem sweep + FlawChess Engine), reversing Phase 154 D-04"
    requirement: FIX-3-SHARED-WORKER
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts — 'one Worker is constructed across two leases' (reverted the sharing guard and confirmed the test fails without it, then restored)"
        status: pass
    human_judgment: true
    rationale: "The mock-Worker unit tests prove the SHARING mechanism (refcount, one Worker, respawn survives) but cannot measure real memory. Confirming the peak-footprint drop from ~3 ONNX sessions to 1 requires Chrome DevTools Memory/Task Manager on a live /analysis page with all three engine toggles on."

duration: ~2h
completed: 2026-07-29
status: complete
---

# Quick Task 260729-sod: Fix Maia WASM OOM on iOS (worker respawn + Sentry tag + shared worker + cache headers) Summary

**Root-caused and fixed the iPhone `/bots` OOM crash (FLAWCHESS-92): `maia-worker.js`'s WebGPU→WASM fallback imported a second ONNX Runtime build into the same worker global instead of releasing the first, leaving ~226 MB alive and reachable — fixed via a worker-respawn protocol, plus a shared single-worker host that also collapses `/analysis`'s 2-3 concurrent Maia workers down to one.**

## Performance

- **Duration:** ~2h
- **Started:** 2026-07-29T19:04:00Z (approx, from first git commit)
- **Completed:** 2026-07-29T19:22:41Z
- **Tasks:** 4
- **Files modified:** 14 (4 created, 10 modified)

## Accomplishments

- **FIX 2 (Task 1):** New `frontend/src/lib/maiaWorkerErrors.ts` classifies raw Maia worker error text into 3 stable buckets (`oom`/`load`/`inference`, OOM-first since the real prod string matches both patterns) and reports a Sentry message that never varies with worker text — raw text moves to `contexts.maia`, a `maia_failure` tag makes every Maia failure filterable in one place. Both `useMaiaEngine.ts` and `maiaQueue.ts` route through it.
- **FIX 1 (Task 2, the core fix):** `maia-worker.js`'s `initSession(mode)` now returns an outcome instead of silently falling through to a second `importScripts` on WebGPU failure. A failure posts a terminal `{type:'webgpu-unavailable', message}` and the worker sits idle; both main-thread owners terminate the dead worker and spawn a fresh one pinned to `backend:'wasm'` (no adapter probe, no WebGPU bundle ever loaded into that heap). A device with no GPU adapter at all still boots in one spawn (no needless respawn). Also closed FLAWCHESS-95 (concurrent `analyze` racing `init`) by holding the `initSession()` promise and awaiting it before the `analyze` branch's session check.
- **FIX 4 (Task 3):** `deploy/Caddyfile` now caches `/maia/*` + `/engine/*` (the 43.6 MB model, ORT/Stockfish wasm bundles) for 30 days (`public, max-age=2592000`, deliberately not `immutable` since filenames aren't content-hashed and ORT resolves its own wasm/mjs names from `wasmPaths`), while `/maia/maia-worker.js` stays `no-cache` since it's our source and Task 2 just changed its message protocol.
- **FIX 3 (Task 4):** New `frontend/src/lib/engine/maiaWorkerHost.ts` — a refcounted singleton owning the Worker lifecycle for every Maia consumer on `/analysis`. Collapses the live chart's `useMaiaEngine`, `useGemSweep`'s own `useMaiaEngine` instance, and the FlawChess Engine's `maiaQueue` from up to 3 concurrent workers (desktop ~678 MB, mobile/low-power 2 workers ~452 MB — the exact OOMing configuration) down to ONE shared worker. Priority leases (the live chart) jump queued background requests without ever preempting an in-flight one. Both consumer disciplines (drop-and-reissue vs no-drop FIFO batching) stay above the host, unmerged.

## Task Commits

1. **Task 1: FIX 2 — distinct, filterable Sentry grouping** - `bd3228bb` (feat)
2. **Task 2: FIX 1 — respawn the worker for the WASM fallback (core fix)** - `b621325b` (fix)
3. **Task 3: FIX 4 — cache headers for /maia/* and /engine/*** - `318c141f` (fix)
4. **Task 4: FIX 3 — one shared, refcounted Maia worker** - `01f5e425` (feat)

**Plan metadata:** committed separately by the orchestrator (docs commit not included in the above).

## Files Created/Modified

- `frontend/src/lib/maiaWorkerErrors.ts` - bounded Sentry classification (oom/load/inference) + capture helper
- `frontend/src/lib/maiaWorkerErrors.test.ts` - classification + capture unit tests
- `frontend/public/maia/maia-worker.js` - `initSession(mode)` outcome-returning respawn protocol, `webgpu-unavailable` message, FLAWCHESS-95 init-race fix
- `frontend/src/hooks/useMaiaEngine.ts` - rewritten to acquire a `maiaWorkerHost` lease instead of constructing a Worker; `priority?` option added
- `frontend/src/lib/engine/maiaQueue.ts` - rewritten to acquire a `priority:false` lease; own same-FEN batching preserved via a local `leaseReady` gate
- `frontend/src/lib/engine/maiaWorkerHost.ts` - new refcounted single-Worker host (lease acquire/release, one-in-flight priority dispatch, respawn + Sentry ownership)
- `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts` - host unit tests (sharing, refcount-to-zero, serialisation, priority queue-jump, worker death, webgpu-unavailable respawn)
- `frontend/src/hooks/useGemSweep.ts` - passes `priority: false` to its `useMaiaEngine` call; header doc corrected (dedicated hook calls, not dedicated Workers)
- `frontend/src/pages/Analysis.tsx` - stale "SEPARATE Worker instance" comment corrected to describe the shared-lease model
- `deploy/Caddyfile` - 30-day cache for vendored `/maia/*`+`/engine/*`, no-cache for `/maia/maia-worker.js`
- `frontend/public/maia/README.md` - new "Cache headers" section documenting the invalidation story
- `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` - rewritten to mock the host lease instead of raw `Worker`
- `frontend/src/lib/engine/__tests__/maiaQueue.test.ts` - rewritten to mock the host lease instead of raw `Worker`
- `CHANGELOG.md` - two `[Unreleased]` bullets (Fixed: the OOM+cache fix; Changed: the shared-worker memory win)

## Decisions Made

- Task order deviated from the user's original 1-2-3-4 listing: FIX 2 (Sentry) went first because it creates the shared `maiaWorkerErrors.ts` helper FIX 1's respawn breadcrumb also needs — this was the plan's own `<task_order_note>`, not a new deviation.
- `maiaQueue.ts` needed a NEW local `leaseReady`/`readyPromiseInFlight` gate (not literally in the plan's prose) to preserve its pre-existing same-FEN batching window against the host's async `whenReady()` — without it, two synchronous `policy()` calls for the same FEN would dispatch as two separate `analyze()` calls instead of one batched call, silently regressing D-04's core optimization. Verified via the existing "collapsing two same-ELO requests into one analyze call" and "batches two DIFFERENT ELOs...deduped" tests, which pass unchanged.
- `onFatal` (worker death) does NOT reset `maiaQueue`'s cached `lease` reference to null — the host's own self-heal contract is "the SAME lease's next `analyze()`/`whenReady()` re-spawns a fresh Worker", not "acquire a new lease". Confirmed via a dedicated test that the same lease is reused after `onFatal` fires.
- `MaiaWorkerLease.analyze()`'s `eloInputs` parameter widened to `readonly number[]` (not `number[]`) so `MAIA_ELO_LADDER` (declared `readonly number[]`) can be passed directly without a copy — caught by `npm run build`'s `tsc -b` step, per CLAUDE.md's Sequence/covariance guidance.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `readonly number[]` type mismatch caught by `tsc -b`**
- **Found during:** Task 4, `npm run build` verification
- **Issue:** `MaiaWorkerLease.analyze(fen, eloInputs: number[])` rejected `MAIA_ELO_LADDER` (typed `readonly number[]` in `maiaEncoding.ts`) — `npm run lint`/`npm test` don't type-check (esbuild strips types), so this only surfaced at `npm run build`, exactly as CLAUDE.md warns.
- **Fix:** Widened the `analyze()` parameter (interface + implementation) to `readonly number[]`.
- **Files modified:** `frontend/src/lib/engine/maiaWorkerHost.ts`
- **Verification:** `npm run build` clean afterward.
- **Committed in:** `01f5e425` (Task 4 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — type mismatch caught by the build gate).
**Impact on plan:** No scope creep; the fix is a one-line type widening required for the plan's own stated design (host accepting `MAIA_ELO_LADDER` directly).

## Issues Encountered

- **Mock-timing mismatch when rewiring `maiaQueue.test.ts`/`useMaiaEngine.test.ts` to the new lease-based mocks:** the old tests relied on `driveReady(worker)` synchronously triggering dispatch (since the old direct-`Worker` implementation gated `processQueue` on a plain synchronous boolean). The host's `whenReady()` is an async `Promise`, adding one real microtask hop between "ready" and "dispatch" — irrelevant in production (real `postMessage` events are already async) but it broke the synchronous mock-driven test assertions. Resolved by making `driveReady` async (`await Promise.resolve()` after simulating ready) and awaiting it at every call site — a purely test-side timing fix, not a production behavior change.
- **Unhandled promise rejection in `maiaWorkerHost.test.ts`'s refcount test:** `lease1.whenReady()` was left unawaited/uncaught before `release()` rejected it. Fixed with a no-op `.catch(() => {})`.
- **`Sentry.addBreadcrumb` missing from the `@sentry/react` mock:** `maiaQueue.test.ts`'s Task-2-added mock only stubbed `captureException`; the new respawn breadcrumb call threw "No addBreadcrumb export is defined on the mock". Fixed by adding `addBreadcrumb: vi.fn()` to the mock (this whole mock block was later deleted in Task 4's rewrite anyway, since `maiaQueue.ts` no longer calls Sentry directly).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Frontend gate fully green: `npm run lint` (0 errors), `npm test -- --run` (2840/2840 passing across 203 files), `npm run build` (tsc -b + vite build clean), `npm run knip` (0 issues).
- **Not verified by this task (explicitly deferred to real-device/manual UAT per the plan's `<verification>` section):**
  1. Real iPhone Safari on `/bots` playing a full bot game without a tab reload — the actual reported symptom and the only real confirmation of the OOM fix.
  2. Chrome DevTools Memory/Task Manager on `/analysis` with all three engine toggles on, confirming the peak Maia footprint drop from ~3 ONNX sessions to 1.
  3. Post-deploy Sentry `maia_failure:oom` filter — this task makes it a filter instead of an archaeology exercise, but no new production events exist yet to filter.
- **Known blind spot carried forward (explicitly out of scope per FINDINGS.md §6):** we still cannot tell how often WebGPU succeeds vs falls back on iOS in aggregate — the fallback breadcrumb (Task 2) narrows this to "attached to any later error" but a success-path backend report was deliberately not planned here.
- Deploy is NOT part of this quick task — the four commits are ready to ship via the normal release flow (`main → production` PR + `bin/deploy.sh`) whenever the next release is cut.

## Self-Check: PASSED

- FOUND: `frontend/src/lib/maiaWorkerErrors.ts`
- FOUND: `frontend/src/lib/engine/maiaWorkerHost.ts`
- FOUND: `frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts`
- FOUND: commit `bd3228bb`
- FOUND: commit `b621325b`
- FOUND: commit `318c141f`
- FOUND: commit `01f5e425`

---
*Quick task: 260729-sod*
*Completed: 2026-07-29*
