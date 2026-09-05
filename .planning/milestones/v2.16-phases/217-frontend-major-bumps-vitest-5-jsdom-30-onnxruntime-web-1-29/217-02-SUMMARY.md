---
phase: 217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29
plan: 02
subsystem: infra
tags: [onnxruntime-web, maia, wasm, webgpu, dependency-bump, cache-invalidation, device-uat]

# Dependency graph
requires:
  - phase: 217-01
    provides: "vitest 5 / jsdom 30 bump squash-merged to main, giving cluster 2 a clean base"
provides:
  - "onnxruntime-web bumped 1.27.0 -> 1.29.0 (exact pin), six vendored Maia runtime files re-vendored and SHA-256-verified against the installed package"
  - "ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK, ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK, ORT_RUNTIME_BYTES_FALLBACK recomputed against the new binaries; ENGINE_ASSET_CACHE_VERSION bumped 1 -> 2"
  - "wasmBinary suppression re-verified headlessly on both 1.29 loaders (one read without, zero with)"
  - "cluster 2 squash-merged to main as 6f19e0567, full pre-merge gate green"
  - "real-device UAT matrix recorded (Chrome-without-WebGPU-adapter leg passed; iOS<16.4, low-memory, and true WebGPU-adapter legs deferred for lack of hardware)"
affects: ["218 parity spike (D-08 onnxruntime-node deferred)"]

actuals:
  tokens: 5615
  tasks: 5
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Runtime binary re-vendor discipline: copy only from node_modules/ post-install, verify by SHA-256 against the installed package, re-grep the bundle-to-binary pairing rather than trust it carried over from the prior version."

key-files:
  created: []
  modified:
    - frontend/package.json
    - frontend/package-lock.json
    - frontend/public/maia/ort.wasm.min.js
    - frontend/public/maia/ort.webgpu.min.js
    - frontend/public/maia/ort-wasm-simd-threaded.mjs
    - frontend/public/maia/ort-wasm-simd-threaded.wasm
    - frontend/public/maia/ort-wasm-simd-threaded.asyncify.mjs
    - frontend/public/maia/ort-wasm-simd-threaded.asyncify.wasm
    - frontend/public/maia/README.md
    - frontend/src/lib/engine/ortRuntimeSource.ts
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/lib/engine/engineAssetCache.ts
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - CHANGELOG.md

key-decisions:
  - "D-06 held: bundle-to-binary pairing re-grepped at 1.29.0 rather than assumed — ort.wasm.min.js still requests exactly ort-wasm-simd-threaded.mjs, ort.webgpu.min.js still requests exactly ort-wasm-simd-threaded.asyncify.mjs; only the two .wasm byte sizes moved (13,961,845 wasm-only, 25,749,873 asyncify)."
  - "D-08 honored: scripts/package.json's onnxruntime-node was NOT touched — its pin comment (>=1.22 segfaults on the vendored Maia model) is the same native core and same measurement reserved for Phase 218's parity spike."
  - "ENGINE_ASSET_CACHE_VERSION bumped 1 -> 2 in the same commit as the binary replacement, per the plan's stated rule that these non-content-hashed assets have no other invalidation path. Cost: one re-download per returning device (~14 MB WASM path, ~26 MB WebGPU path) — recorded in CHANGELOG.md, unlike 217-01 which added no entry."
  - "wasmBinary suppression check script instrumentation bug found and fixed during Task 3: the 1.29 loader factory reads its .wasm in a later microtask, so fs.readFileSync instrumentation had to stay installed until the factory's returned promise settled, not just for the synchronous call. A first attempt produced a false zero-read baseline, caught by the plan's own 'zero-read baseline is inconclusive, not a pass' rule before any conclusion was drawn."
  - "Checkpoint-pause bookkeeping (commit 5bc823f90 on main) recorded Tasks 1-4 complete and paused at the Task 5 human-verify gate, per the mandatory-checkpoint protocol — a dependency-vendoring change touching a real GPU/SIMD/memory-limited code path is not something CI can stand in for (D-07)."
  - "Task 5 UAT scope was narrowed by hardware availability on this run: only a modern desktop Chrome (no WebGPU adapter, so it exercises the WASM-only decision path) was available. iOS <16.4, a low-memory device, and a desktop browser with an actual WebGPU adapter were all deferred rather than skipped silently, per the plan's explicit deferral clause."

patterns-established:
  - "Byte-constant re-verification against stat, not against research projections, whenever a vendored binary is replaced (see Task 1/2 verify commands in 217-02-PLAN.md)."

requirements-completed: []

coverage:
  - id: D1
    description: "onnxruntime-web resolves at 1.29.0 and all six vendored runtime files are SHA-256-identical to the installed package, with the bundle-to-binary pairing re-grepped rather than assumed"
    verification:
      - kind: other
        ref: "npm ls onnxruntime-web -> onnxruntime-web@1.29.0; sha256sum equality check for all six files vs node_modules/onnxruntime-web/dist/; grep pairing check on both API bundles"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every byte constant coupled to the replaced binaries matches the on-disk file size; ENGINE_ASSET_CACHE_VERSION bumped to 2; both encoding tests updated without weakening intent"
    verification:
      - kind: unit
        ref: "cd frontend && npm test -- --run src/lib/engine/__tests__/engineAssetProgress.test.ts src/components/bots/__tests__/EngineReadyGate.test.tsx src/lib/engine/__tests__/ortRuntimeSource.test.ts src/lib/engine/__tests__/engineAssetCache.test.ts"
        status: pass
      - kind: other
        ref: "node cross-check script comparing ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK / ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK / ORT_RUNTIME_BYTES_FALLBACK against fs.statSync of the vendored .wasm files -> all MATCH"
        status: pass
    human_judgment: false
  - id: D3
    description: "wasmBinary handoff still suppresses the runtime's own .wasm read on both 1.29 loaders (one read without wasmBinary, zero with it)"
    verification:
      - kind: other
        ref: "headless Node script in scratchpad driving both re-vendored .mjs loaders twice each (with/without wasmBinary); result recorded in frontend/public/maia/README.md under the 'v1.29.0 re-check' dated line"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full CLAUDE.md pre-merge gate plus npm run build and npx audit-ci green, cluster 2 squash-merged to main as its own commit"
    verification:
      - kind: integration
        ref: "ruff format/check, ty (app+analysis), check_function_size.py, pytest -n auto -x, npm run lint, npm test -- --run, npm run build, npx audit-ci --config audit-ci.jsonc — all green before squash-merge 6f19e0567"
        status: pass
    human_judgment: false
  - id: D5
    description: "Real-device UAT matrix (D-07/SC-4) — iOS<16.4 fallback, low-memory OOM, modern-device inference on WebGPU and WASM-only paths, single main-thread .wasm devtools request, returning-device cache re-download"
    verification:
      - kind: manual_procedural
        ref: "Desktop Chrome 152/Linux (no WebGPU adapter, WASM-only decision path) exercised directly by raw Worker + app host + live Bots UI; project owner confirmed localhost:5173 (this build) and localhost:5179 (pre-bump control) both work"
      - kind: other
        ref: "CacheStorage inspection: flawchess-engine-assets-v1 replaced by v2-only after first spawn, v2 holds the new 13,961,845-byte wasm plus maia3_simplified.onnx and the Stockfish wasm"
    human_judgment: true
    rationale: "iOS<16.4, low-memory, and true-WebGPU-adapter legs were deferred for lack of available hardware on this run — a human (project owner) must confirm those legs before this cluster's D-07 coverage is considered fully closed, even though the modern-device leg that was exercised passed and was owner-approved."

duration: ~15min (Tasks 1-4 pre-squash) + checkpoint resolution session
completed: 2026-09-05
status: complete
---

# Phase 217 Plan 02: onnxruntime-web 1.29.0 Re-vendor + Device UAT Summary

**onnxruntime-web bumped 1.27.0 -> 1.29.0 with all six vendored Maia runtime binaries re-vendored, SHA-256-verified, byte constants and cache version updated, wasmBinary suppression re-proven, squash-merged to main, and the device UAT matrix recorded with one modern-device leg passed and three legs explicitly deferred for lack of hardware**

## Performance

- **Duration:** ~15 min for Tasks 1-4 (pre-squash-merge), plus a separate checkpoint-resolution session for Task 5
- **Started:** 2026-09-05 (approx., see 217-01-SUMMARY.md for Plan 01 handoff timing)
- **Completed:** 2026-09-05
- **Tasks:** 5 of 5 complete (4 automated + 1 human-verify checkpoint, resolved)
- **Files modified:** 17 (8 vendored binary/README files, 6 source/test files, package.json/package-lock.json, CHANGELOG.md)

## Accomplishments

- `onnxruntime-web` moved from `1.27.0` to `1.29.0` (exact pin, no caret) in `frontend/package.json`, lockfile regenerated via `npm install`.
- All six vendored runtime files under `frontend/public/maia/` (`ort.wasm.min.js`, `ort.webgpu.min.js`, `ort-wasm-simd-threaded.mjs`/`.wasm`, `ort-wasm-simd-threaded.asyncify.mjs`/`.wasm`) re-copied from the freshly installed package and SHA-256-verified identical to `node_modules/onnxruntime-web/dist/`. `git ls-files frontend/public/maia` stayed at 9 — no file added or removed.
- Bundle-to-binary pairing re-grepped per D-06 rather than assumed: `ort.wasm.min.js` still requests exactly `ort-wasm-simd-threaded.mjs`, `ort.webgpu.min.js` still requests exactly `ort-wasm-simd-threaded.asyncify.mjs`. Only the two `.wasm` byte sizes moved — 13,961,845 (wasm-only, was 13,479,978) and 25,749,873 (asyncify, was 24,254,953) — matching the 217-RESEARCH.md projections exactly.
- `ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK`, `ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK`, and `ORT_RUNTIME_BYTES_FALLBACK` all updated to the new observed sizes, with refreshed `verified live` dates and no stale pre-bump byte literal left anywhere under `frontend/src` or in the README.
- `ENGINE_ASSET_CACHE_VERSION` bumped `1` -> `2` in the same commit as the binary replacement, arming the only invalidation path these non-content-hashed assets have.
- Both encoding tests (`engineAssetProgress.test.ts`'s three-asset denominator, `EngineReadyGate.test.tsx`'s "rounds to 100 while bytes still arriving") updated to the new byte arithmetic without weakening their original assertions.
- Headless `wasmBinary` suppression check re-run against both 1.29.0 loaders: exactly one `.wasm` read without `wasmBinary` set, zero with it, on both builds — the Phase 213-09 byte-ownership contract holds unchanged. A loader-factory microtask timing bug in the check script itself was caught and fixed before drawing that conclusion (see Deviations).
- Full CLAUDE.md pre-merge gate (backend + frontend) plus `npm run build` and `npx audit-ci --config audit-ci.jsonc` all green; cluster 2 squash-merged to `main` as `6f19e0567`, a single revertable commit separate from cluster 1's `6ca0f8ecd`.
- CHANGELOG.md entry added under `## [Unreleased]` / `### Changed`, unlike cluster 1, because this bump has a real user-visible cost (one engine-asset re-download per returning device).
- Task 5 device UAT matrix executed: the one leg reachable with available hardware (modern desktop Chrome without a WebGPU adapter, exercising the WASM-only decision path) passed with multiple layers of evidence and was independently confirmed by the project owner comparing this build against a pre-bump control server; the three legs requiring unavailable physical hardware (iOS <16.4, low-memory device, a browser with a real WebGPU adapter) are recorded as deferred, not silently skipped.

## Task Commits

1. **Task 1: Bump onnxruntime-web to 1.29.0, re-vendor six runtime files** - `72d04f84c` (chore) — on the (now-deleted) phase branch
2. **Task 2: Update byte constants, ENGINE_ASSET_CACHE_VERSION 1->2, tests, README** - `8be814372` (chore/test) — on the (now-deleted) phase branch
3. **Task 3: Re-run headless wasmBinary suppression check on both 1.29 loaders** - `fbe8ec2d2` (docs) — on the (now-deleted) phase branch
4. **Task 4: Full pre-merge gate, CHANGELOG bullet, squash-merge to main** - `ea9c65672` (changelog commit, pre-squash) -> squash-merged onto `main` as `6f19e0567`
5. **Task 5: HUMAN-UAT — real-device matrix** - checkpoint resolved by the project owner; no separate commit (result recorded in this SUMMARY per plan instructions, since it produces no code change)

**Checkpoint-pause bookkeeping:** `5bc823f90` (docs, STATE.md only) — recorded Tasks 1-4 complete and the pause at Task 5, per the mandatory-checkpoint protocol.

**Plan metadata:** this commit (docs: complete plan)

## Files Created/Modified

- `frontend/package.json` - `onnxruntime-web` bumped to exact `1.29.0`
- `frontend/package-lock.json` - regenerated by `npm install`
- `frontend/public/maia/ort.wasm.min.js` / `ort.webgpu.min.js` / `ort-wasm-simd-threaded.mjs` / `ort-wasm-simd-threaded.wasm` / `ort-wasm-simd-threaded.asyncify.mjs` / `ort-wasm-simd-threaded.asyncify.wasm` - re-vendored from the 1.29.0 install, SHA-256-verified
- `frontend/public/maia/README.md` - package version updated in both runtime tables, new pairing-table sizes, SHA-256 provenance table for the six runtime files, dated "v1.29.0 re-check" wasmBinary suppression record
- `frontend/src/lib/engine/ortRuntimeSource.ts` - two byte constants and their docstrings updated to the new sizes and dates
- `frontend/src/lib/engine/engineAssetProgress.ts` - `ORT_RUNTIME_BYTES_FALLBACK` and its docstring's inline MB figures updated
- `frontend/src/lib/engine/engineAssetCache.ts` - `ENGINE_ASSET_CACHE_VERSION` 1 -> 2 with a comment naming the cause
- `frontend/src/lib/engine/maiaWorkerHost.ts` - prose byte/MB figure updated to match the new constants
- `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts` - three-asset denominator expectation and `ASYNCIFY_TOTAL` literal recomputed
- `frontend/src/lib/engine/__tests__/ortRuntimeSource.test.ts` - byte-size assertion updated
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` - loaded-bytes literal raised so the aggregate still rounds to 100 while remaining genuinely short of the new total
- `CHANGELOG.md` - one bullet under `## [Unreleased]` / `### Changed`, suffixed `(Phase 217)`

## Decisions Made

- **D-06 held exactly:** the bundle-to-binary pairing was re-grepped, not assumed, and matched the prior version's pairing unchanged — only the two `.wasm` byte sizes moved.
- **D-08 honored:** `scripts/package.json`'s `onnxruntime-node` pin was deliberately left untouched; its `>=1.22 segfaults` note is the same native core and measurement reserved for Phase 218's parity spike, and this plan does not pre-empt that.
- **ENGINE_ASSET_CACHE_VERSION bumped in the same commit as the binary swap**, per the plan's non-negotiable rule that these assets are not content-hashed and have no other invalidation path. The one-re-download-per-device cost is documented in CHANGELOG.md.
- **wasmBinary suppression script bug found and fixed mid-task:** the 1.29 loader factory performs its actual `.wasm` read in a later microtask rather than synchronously, so `fs.readFileSync` instrumentation had to remain installed until the factory's returned promise settled. The first attempt produced a false zero-read baseline; the plan's own "a zero-read baseline is inconclusive, not a pass" rule caught this before any conclusion was drawn, and the script was fixed before the real result was recorded.
- **Checkpoint-pause bookkeeping landed as a standalone commit (`5bc823f90`) on `main`**, ahead of this SUMMARY, because the executor that completed Tasks 1-4 stopped at the mandatory Task 5 `checkpoint:human-verify` gate and a fresh continuation agent (this one) picked up from there — this is the designed checkpoint protocol, not a deviation.
- **Task 5 UAT scope decision:** given the hardware actually available for this run (a Linux desktop with Chrome that exposes `navigator.gpu` but resolves no WebGPU adapter), the executable leg was the WASM-only decision path, and it was exercised with multiple independent layers of evidence (raw worker probe, the app's own singleton host, the live Bots UI, and the engine-asset progress snapshot) rather than a single smoke test. The remaining three legs (iOS <16.4, low-memory, and a true WebGPU-adapter browser) were explicitly deferred rather than silently skipped, per the plan's own deferral clause, and the project owner independently confirmed the build works on both this server and a pre-bump control server before marking the checkpoint passed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] wasmBinary suppression script's instrumentation window was too short for the 1.29 loader's async factory**
- **Found during:** Task 3
- **Issue:** The throwaway headless Node script's `fs.readFileSync` instrumentation was uninstalled immediately after the synchronous module-factory call returned. The 1.29.0 loader factory is async and performs its actual `.wasm` read in a later microtask, so the first run produced a false zero-read baseline in the no-`wasmBinary` case — indistinguishable from a genuinely suppressed read without the fix.
- **Fix:** Kept the `fs.readFileSync` instrumentation installed until the factory's returned promise settled, not just for the duration of the synchronous call.
- **Files modified:** none in the repo — the script is a scratchpad throwaway per plan design (Phase 213-09 precedent); only the corrected result is recorded in `frontend/public/maia/README.md`.
- **Verification:** Re-run produced the expected one-read-without/zero-read-with result on both 1.29.0 loaders, matching the 1.27.0 baseline.
- **Committed in:** `fbe8ec2d2` (the README record commit; the script itself was never committed, as intended)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in the throwaway verification tooling, not in shipped code)
**Impact on plan:** No scope creep. The bug was in the disposable measurement script, not in any file this plan ships; catching it before drawing a conclusion is exactly what the plan's "zero-read baseline is inconclusive, not a pass" rule was designed to force.

## Issues Encountered

- `npm run dev:tunnel` could not be started during the Task 5 UAT session: `cloudflared` is not installed on this machine, and the executor declined to perform an unattended global install of a network tunneling tool. Worked around by using the LAN address from `npm run dev:mobile` (`http://192.168.50.179:5173`) plus `localhost:5173`, which sufficed for the desktop-Chrome leg that was actually exercised. This blocks nothing that iOS Safari legs would have needed HTTPS for, since no iOS device was available on this run regardless.
- No physical iOS <16.4 device, no physical low-memory device, and no desktop/laptop browser with an actual WebGPU adapter were available to this run. All three legs are recorded as deferred below rather than exercised.

## User Setup Required

None - no external service configuration required. (The plan's `user_setup` entry described the device-matrix access itself, which was addressed via LAN/localhost URLs during the Task 5 session; no separate action is needed from the user beyond what's already recorded in the UAT results below.)

## UAT Results (Task 5, D-07/SC-4)

- **Leg 1, iOS < 16.4 (no WASM SIMD):** DEFERRED — no such physical device was available to the run. Not exercised.
- **Leg 2, low-memory device:** DEFERRED — no such physical device was available to the run. Not exercised.
- **Leg 3, modern device:**
  - **Desktop Chrome 152 on Linux x86_64** (`Mozilla/5.0 (X11; Linux x86_64) Chrome/152.0.0.0`), served from the Vite dev server with `--host`, **WASM-only path: PASSED**. This Chrome exposes `navigator.gpu` but `requestAdapter()` resolves `null`, so the app's host chose the `wasm` backend — the same decision Safari 17+ would produce. Evidence:
    (a) a raw `new Worker('/maia/maia-worker.js')` fed the cached 1.29 runtime via `wasmBinary` reported `ready` (backend `wasm`) at 1.3 s and returned an inference `result` 260 ms later;
    (b) the app's own singleton host (`acquireMaiaWorker`, imported through Vite) reported `getBackend() === 'wasm'`, `whenReady()` resolved immediately, and `analyze()` for three ELOs (1100/1500/1900) returned 4352-entry policies and WDL in 495 ms;
    (c) in the real Bots UI, the Maia-based bot "Pip the Ant (~900)" answered 4.Nf3 with Nxd4 within seconds;
    (d) the engine-asset snapshot reported ort-runtime 13,961,845/13,961,845 done, maia-model done, status ready;
    (e) the project owner opened the Analysis page Maia panel in the same browser against this build (localhost:5173) and against a pre-bump 1.27.0 control build (localhost:5179) and confirmed both work — marked passed by the owner.
  - **WebGPU path (desktop Chrome with a WebGPU adapter):** DEFERRED — the available Chrome has no WebGPU adapter on this Linux machine, so the webgpu loader could only be exercised headlessly (Task 3), not in a real browser.
  - **Safari 17+:** DEFERRED — no Safari available on Linux; the WASM-only decision path was covered by the Chrome-without-adapter leg above.
- **Devtools single-`.wasm`-request check:** PASSED for what the tooling can see — after deleting the `flawchess-engine-assets-v2` CacheStorage entry and reloading `/analysis`, the browser-extension network log showed exactly one runtime request to `/maia/ort-wasm-simd-threaded.wasm` (HTTP 200, 13,961,845 bytes reported by the progress store), issued by the main thread's runtime fetch, plus the unrelated Stockfish `.wasm`. **Caveat:** the extension's network log does not surface Worker-initiated fetches (the worker's own `maia3_simplified.onnx` fetch was likewise invisible), so "none from the worker" rests on the Task 3 headless check rather than on browser devtools alone.
- **Returning-device cache invalidation:** PASSED — before this build was opened the browser held `flawchess-engine-assets-v1`; after the first Maia spawn on the 1.29 build the keys were `flawchess-engine-assets-v2` only (v1 deleted), and v2 contained `/maia/ort-wasm-simd-threaded.wasm` at exactly 13,961,845 bytes plus `/maia/maia3_simplified.onnx` and the Stockfish wasm. The engine assets were re-downloaded once, as designed.
- **Environment notes:** `npm run dev:tunnel` could not be started (cloudflared not installed; the executor declined an unattended global install); the LAN URL `http://192.168.50.179:5173` was available instead. No deploy was performed.

## Next Phase Readiness

- `main` is now at `6f19e0567`, with cluster 2's dependency bump on top of cluster 1's `6ca0f8ecd`. `git revert` restores the 1.27.0 binaries and constants exactly, at the cost of one more re-download per returning device.
- The phase branch used for wave 2 was deleted after the squash-merge; the checkpoint-pause and this SUMMARY's docs commit landed (or will land) on a freshly recreated `gsd/phase-217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29` branch — see the executor's final report for the exact branch name at commit time.
- **Open item carried forward, not blocking:** three of the four Task 5 UAT legs (iOS <16.4, low-memory device, true-WebGPU-adapter browser) remain deferred for lack of hardware. If a device becomes available before the next `/deploy`, re-running those legs against this same build (already on `main`, not yet deployed) would close out D-07/SC-4 fully; until then, this is a known residual gap in device coverage for a code path that CI cannot exercise, not a defect in the shipped code.
- Phase 217 is now fully executed (both plans complete); no deploy has occurred yet — `/deploy` remains a separate, later action per the plan's explicit "do not deploy" instruction.
- Phase 218's parity spike (D-08 deferral) is unblocked to pick up `scripts/package.json`'s `onnxruntime-node` bump/segfault investigation, now that the browser-side runtime has already moved to 1.29.0.

---
*Phase: 217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29*
*Completed: 2026-09-05*

## Self-Check: PASSED

- FOUND: `.planning/phases/217-frontend-major-bumps-vitest-5-jsdom-30-onnxruntime-web-1-29/217-02-SUMMARY.md` (this file)
- FOUND: `6f19e0567` (squash-merge commit on `main`, verified via `git log --oneline -6 main`)
- FOUND: `5bc823f90` (checkpoint-pause bookkeeping commit on `main`)
- `frontend/package.json` confirmed on disk: `"onnxruntime-web": "1.29.0"` (line 34)
- `frontend/src/lib/engine/engineAssetCache.ts` confirmed on disk: `ENGINE_ASSET_CACHE_VERSION = 2` (line 50)
- `CHANGELOG.md` confirmed on disk: onnxruntime-web 1.27.0 -> 1.29.0 bullet present under `## [Unreleased]`
- `frontend/public/maia/README.md` confirmed on disk: `v1.29.0 re-check (2026-09-05, Phase 217-02)` dated suppression-check record present
- `72d04f84c`, `8be814372`, `fbe8ec2d2`, `ea9c65672` referenced as pre-squash Task commits per the continuation prompt's completed-tasks table; not independently re-verified via `git log --all` since they are squashed into `6f19e0567` (same designed outcome as 217-01's Task commits, documented there).
