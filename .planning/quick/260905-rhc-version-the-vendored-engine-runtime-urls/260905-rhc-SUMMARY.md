---
quick_id: 260905-rhc
phase: quick
plan: 260905-rhc
subsystem: frontend/engine
tags: [caching, cdn, cloudflare, onnxruntime-web, stockfish, maia, service-worker]
status: complete
dependency-graph:
  requires: []
  provides:
    - "ENGINE_ASSET_VERSION_QUERY / versionedEngineAssetUrl() — single ?v=<n> suffix source, derived from ENGINE_ASSET_CACHE_VERSION"
    - "Every runtime-fetched /maia/* and /engine/* URL under frontend/src is version-pinned by query string"
    - "maia-worker.js builds every asset URL (model fetch/cache key, both importScripts calls, both wasmPaths assignments) through its own versionedAssetUrl() helper, fed by the init message's assetVersionQuery field"
    - "A durable source-gate test fails if any non-test file under frontend/src regains a bare engine-asset URL literal"
  affects:
    - "frontend/src/lib/engine/engineAssetCache.ts"
    - "frontend/src/lib/engine/stockfishWorkerSource.ts"
    - "frontend/src/lib/engine/ortRuntimeSource.ts"
    - "frontend/src/lib/engine/maiaWorkerHost.ts"
    - "frontend/public/maia/maia-worker.js"
    - "frontend/vite.config.ts (Workbox precache manifest)"
    - "deploy/Caddyfile (@vendored_runtime cache policy — comment only)"
tech-stack:
  added: []
  patterns:
    - "One version constant (ENGINE_ASSET_CACHE_VERSION) feeds three cache layers at once: CacheStorage name, browser HTTP cache, and CDN edge — via a shared ?v=<n> query suffix, never a second independent version source"
    - "A classic (non-module) Worker that cannot import a TS constant receives it on the init message instead (assetVersionQuery, mirroring the pre-existing assetCacheName precedent)"
    - "ort.env.wasm.wasmPaths as the OBJECT form ({ mjs, wasm } per backend) instead of a bare string prefix, because a string prefix cannot carry a query string"
key-files:
  created: []
  modified:
    - frontend/src/lib/engine/engineAssetCache.ts
    - frontend/src/lib/engine/stockfishWorkerSource.ts
    - frontend/src/lib/engine/ortRuntimeSource.ts
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/public/maia/maia-worker.js
    - frontend/src/hooks/useStockfishEngine.ts
    - frontend/src/lib/engine/__tests__/engineAssetCache.test.ts
    - frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerScript.test.ts
    - frontend/src/lib/engine/__tests__/maiaWorkerHost.test.ts
    - frontend/src/lib/engine/__tests__/maiaQueue.test.ts
    - frontend/vite.config.ts
    - frontend/public/maia/README.md
    - deploy/Caddyfile
    - CHANGELOG.md
decisions:
  - "Kept the exported constant names (STOCKFISH_ENGINE_GLUE_PATH etc.) and changed only their values to versionedEngineAssetUrl(...) calls, per the plan's D-02 — zero test churn on the symbol-agnostic ortRuntimeSource.test.ts/maiaWorkerHost.test.ts assertions."
  - "In maia-worker.js's fetchModelBuffer, the model's versioned URL is computed via versionedAssetUrl(MODEL_PATH) at BOTH the cache match/put call sites (via a local) AND independently at the fetch() call site, rather than funneling all three through one stored local — see Deviations for why."
  - "Closed the Stockfish degraded path (D-05): createStockfishWorker(null) now always appends an encoded location-hash, passing STOCKFISH_ENGINE_WASM_PATH explicitly instead of letting the vendored glue derive an unversioned wasm URL from location.pathname."
metrics:
  duration: "~45 minutes"
  completed: 2026-09-05
actuals:
  tokens: 11696
  tasks: 3
  commits: 3
---

# Quick task 260905-rhc: version the vendored engine runtime URLs Summary

Every runtime-fetched `/maia/*` and `/engine/*` URL (Maia model, onnxruntime-web runtime binaries, the Maia worker script itself, and the Stockfish glue + wasm) now carries a `?v=<n>` query suffix derived from one constant, `ENGINE_ASSET_CACHE_VERSION` — so a stale Cloudflare edge entry (the actual prod incident: 1.27.0 bytes served under `/maia/*` for up to 30 days after a 1.29.0 deploy) can never be served again after a version bump, because a CDN and the browser's HTTP cache both key a cached response on the full URL including its query string.

## What was built

**Task 1 (tracer):** `engineAssetCache.ts` bumped `ENGINE_ASSET_CACHE_VERSION` 2 → 3 (documented reason: the URLs built from it now carry the query, so every existing `...-v2` CacheStorage entry becomes an orphan the next sweep deletes) and added `ENGINE_ASSET_VERSION_QUERY` (the `?v=<n>` string) plus `versionedEngineAssetUrl(path)` — the single call site every versioned URL constant is built through. `stockfishWorkerSource.ts` wrapped both `STOCKFISH_ENGINE_GLUE_PATH` and `STOCKFISH_ENGINE_WASM_PATH` in the helper and closed the D-05 degraded-path hole: `createStockfishWorker(null)` now always appends an encoded location-hash carrying `STOCKFISH_ENGINE_WASM_PATH`, instead of letting the vendored glue's own fallback derive an unversioned `.wasm` URL from `location.pathname` (which drops the query string). Rewrote the two worker-construction contract tests to assert the hash-wrapped null branch and the `?v=<digits>` query on the glue URL in both branches. Added the "one-knob" invariant test in `engineAssetCache.test.ts`: `versionedEngineAssetUrl()` output matches `?v=<digits>` by regex, and those digits equal the digits embedded in `ENGINE_ASSET_CACHE_NAME` — both assertions regex-based so a future bump never requires editing the test. Also fixed a now-stale comment in `useStockfishEngine.ts` that described the null-branch behavior pre-D-05.

Verification: `npx vitest run engineAssetCache.test.ts stockfishWorkerSource.test.ts` — 40/40 passed, including the pre-existing Stockfish source gate.

**Task 2:** `ortRuntimeSource.ts` wrapped `ORT_RUNTIME_WASM_ONLY_PATH`/`ORT_RUNTIME_ASYNCIFY_PATH` in the helper and corrected the file header's stale description of `wasmPaths` as a string prefix. `maiaWorkerHost.ts` wrapped `ENGINE_PATH` and extended `InitMessage` with `assetVersionQuery?: string`, set from `ENGINE_ASSET_VERSION_QUERY` in the same object literal that already sets `assetCacheName` in `constructWorker` — covering both the normal spawn and the wasm-pinned respawn with one assignment. `maia-worker.js`: added four new asset-file constants (`ORT_WASM_ONLY_MJS_PATH`/`ORT_WASM_ONLY_WASM_PATH`/`ORT_ASYNCIFY_MJS_PATH`/`ORT_ASYNCIFY_WASM_PATH`), deleted `WASM_ASSET_PREFIX`, added `assetVersionQuery` module state plus a `versionedAssetUrl()` helper (set from the init message before `initSession` runs), and routed every asset URL through it: the model fetch/cache key inside `fetchModelBuffer`, both `importScripts` calls, and both `ort.env.wasm.wasmPaths` assignments — now the object form `{ mjs, wasm }` with per-backend versioned URLs, since a bare string prefix cannot carry a query. Rewrote `maiaWorkerScript.test.ts`'s asset-versioning coverage against the sandboxed worker's ACTUAL `importScriptsCalls`/`fetchCalls`/`cacheStore`/`ort.env.wasm.wasmPaths` (never a source grep), including a degrade case (absent `assetVersionQuery` → unversioned URLs, still initializes). Extended `maiaWorkerHost.test.ts`'s two existing `assetCacheName` init-message tests to also assert `assetVersionQuery`. Replaced `maiaQueue.test.ts`'s exact-literal `ENGINE_PATH` assertion with a `?v=<digits>` regex.

Verification: `npx vitest run maiaWorkerScript.test.ts maiaWorkerHost.test.ts maiaQueue.test.ts ortRuntimeSource.test.ts` — 111/111 passed.

**Task 3:** Added a durable source gate to `engineAssetCache.test.ts` (`listSourceFiles`/`stripCommentLines` copied verbatim from the existing stockfish gate) — a regex alternation whose first branch consumes every `versionedEngineAssetUrl('/maia/...'|'/engine/...')` call, so any surviving match that doesn't start with the helper name is an unwrapped offender. **Demonstrated red before committing**: pasted a bare `'/maia/should-fail.js'` literal into a throwaway non-test file, ran the gate, confirmed it failed (`offenders` contained the scratch file), then deleted the file and confirmed green again — repeated a second time against the final code state for the same result (see Proof below). `vite.config.ts` added `maia/**`/`engine/**` to `workbox.globIgnores` (D-07) — those files are now requested under versioned URLs Workbox's precache route can never match against bare-path manifest entries, so precaching them would only add install cost. Updated `public/maia/README.md`'s CacheStorage/Cache-headers/PWA-precache sections and `deploy/Caddyfile`'s `@vendored_runtime` comment (no directive/matcher changed) to describe the three-layer invalidation. Added a `CHANGELOG.md` `[Unreleased] → Fixed` bullet.

## Proof obligation (plan-mandated)

- **Gate demonstrated red, then reverted** (twice — once mid-task, once against the final committed code): a bare `/maia/should-fail.js` literal in a scratch file failed the gate with `offenders: [{ file: '.../__scratch_gate_check.ts', match: "'/maia/should-fail.js'" }]`; deleting the file restored a clean pass (21/21 in `engineAssetCache.test.ts`). The scratch file was never staged or committed.
- **Task 2's worker assertions read the URLs the sandboxed worker ACTUALLY passed** to `importScripts`, `fetch`, `cache.put`/`cache.match`, and `ort.env.wasm.wasmPaths` — never a grep for `versionedAssetUrl` in the worker source.
- **The "one knob" test compares digits, never hardcodes a version number** — `ENGINE_ASSET_VERSION_QUERY`'s digits against `ENGINE_ASSET_CACHE_NAME`'s digits, via regex capture groups.

## Final gate (from repo root except `npm run build`)

```
$ (cd frontend && npm run lint)
> eslint .
(clean, no output)

$ (cd frontend && npm test -- --run)
Test Files  253 passed (253)
     Tests  3912 passed (3912)
  Duration  62-65s

$ (cd frontend && npm run build)
✓ built in ~2-3s
Prerendered 2 pages: / , /privacy
PWA v1.3.0 — mode generateSW — precache 20 entries (2614.37 KiB)
files generated: dist/sw.js.map dist/sw.js dist/workbox-*.js.map dist/workbox-*.js
(exit 0; confirmed no /maia/ or /engine/ URLs appear anywhere in the generated dist/sw.js precache manifest)

$ grep -rnE "['\"]/(maia|engine)/" frontend/src --include='*.ts' --include='*.tsx' \
    | grep -v '/__tests__/' | grep -vE ':[[:space:]]*(\*|//)' | grep -cv 'versionedEngineAssetUrl('
0

$ grep -nE "\b(fetch|importScripts)\(" frontend/public/maia/maia-worker.js \
    | grep -vE ':[[:space:]]*(\*|//)' | grep -cv 'versionedAssetUrl('
0
```

Both greps confirmed non-vacuous at planning time (dry-run reported 5 and 3 respectively against the unfixed tree — see PLAN.md's Planning-time audit).

## Deviations from Plan

### 1. [Clarification, not a Rule 1-4 fix] `fetchModelBuffer`'s fetch call re-invokes `versionedAssetUrl(MODEL_PATH)` directly instead of reusing a single stored local for all three uses

- **Found during:** Task 3, running the second required grep (`grep -nE "\b(fetch|importScripts)\(" ... | grep -cv 'versionedAssetUrl('` must output `0`).
- **Issue:** Task 2's action text said to "Compute the versioned model URL once per `fetchModelBuffer` call into a local so the cache key and the fetch URL cannot drift apart." I initially did this literally — one `const versionedModelUrl = versionedAssetUrl(MODEL_PATH)` reused at `cache.match`, `fetch`, and `cache.put`. That satisfies the anti-drift intent but makes the `fetch(versionedModelUrl)` line textually invisible to Task 3's grep, which checks that the literal substring `versionedAssetUrl(` appears on every `fetch(`/`importScripts(` line. The plan's own dry-run count (3, exactly the model fetch plus both `importScripts` calls) confirms the grep is meant to see the helper called inline at each of those three sites.
- **Fix:** Kept the local (used for `cache.match`/`cache.put`, two textually distant call sites where a shared local has the most anti-drift value) but changed the `fetch()` call site to invoke `versionedAssetUrl(MODEL_PATH)` inline. Both compute the exact same value — `versionedAssetUrl` is a pure function of the module-level `assetVersionQuery` (fixed for the whole init cycle) and the constant `MODEL_PATH` — so there is no actual drift risk between the two call forms; this is a textual/gate-legibility choice, not a behavior change. Added a comment at the fix site explaining why.
- **Files modified:** `frontend/public/maia/maia-worker.js` (already in the plan's file list; no scope change).
- **Verification:** Both Task 3 greps output `0`; `maiaWorkerScript.test.ts` (40 tests covering this exact worker) still 100% pass, confirming the model fetch/cache-key/wasmPaths behavior is unchanged.
- **Committed in:** `fd7a0116e` (Task 3 commit).

No other deviations. All other plan instructions — the D-01 through D-07 design decisions, the exact test additions specified per task, the "explicitly NOT done" list (Caddyfile stays `max-age=2592000`, `@maiaworker`'s `no-cache` rule unchanged, no constant renames, the four hook-mock test files left untouched) — were followed exactly as written.

## Known Stubs

None.

## Threat Flags

None — this task only changes how existing vendored asset URLs are constructed (adding a query-string suffix) and updates cache-layer documentation/config; it introduces no new network endpoints, auth paths, or trust-boundary changes.

## Self-Check: PASSED

- `frontend/src/lib/engine/engineAssetCache.ts` — FOUND, modified.
- `frontend/src/lib/engine/stockfishWorkerSource.ts` — FOUND, modified.
- `frontend/src/lib/engine/ortRuntimeSource.ts` — FOUND, modified.
- `frontend/src/lib/engine/maiaWorkerHost.ts` — FOUND, modified.
- `frontend/public/maia/maia-worker.js` — FOUND, modified.
- `frontend/src/hooks/useStockfishEngine.ts` — FOUND, modified.
- `frontend/vite.config.ts` — FOUND, modified.
- `frontend/public/maia/README.md` — FOUND, modified.
- `deploy/Caddyfile` — FOUND, modified.
- `CHANGELOG.md` — FOUND, modified.
- Commit `e00e52e91` (Task 1: version knob + Stockfish) — FOUND in `git log`.
- Commit `44bf68183` (Task 2: ORT runtime + Maia worker) — FOUND in `git log`.
- Commit `fd7a0116e` (Task 3: source gate, precache, docs) — FOUND in `git log`.
- Working tree clean after all three commits (`git status --short` empty), no stray scratch files from the red-gate proof.
