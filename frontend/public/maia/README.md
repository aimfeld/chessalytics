# Maia-3 model + onnxruntime-web runtime (vendored)

These files are runtime data assets served verbatim from `public/maia/` (no Vite bundler
processing), mirroring the Stockfish `public/engine/` precedent. They are loaded client-side by a
dedicated Web Worker via `onnxruntime-web`; no server-side inference and no runtime third-party
fetch (reproducible builds, offline-capable).

## Model artifact — `maia3_simplified.onnx`

The Maia-3 ("Chessformer", Monroe et al.) inference model, committed **unmodified** (no
fine-tuning, quantization-in-place, or graph edits — AGPL §13 / MAIA-01).

| Field | Value |
|-------|-------|
| File | `maia3_simplified.onnx` |
| SHA-256 | `405bf76c15727dad8728b352c06a8f3c1b80fb2760e8d666b32485c63d75b856` |
| Size | 45,683,686 bytes (~43.6 MB) |
| Source URL | https://maiachess.com/maia3/maia3_simplified.onnx |
| Obtained | 2026-07-05 |
| Producer | pytorch 2.1 → ONNX (per the file's producer metadata) |

This is the exact ONNX artifact the maiachess.com reference client downloads (its default
`NEXT_PUBLIC_MAIA_MODEL_URL` resolves to `/maia3/maia3_simplified.onnx`;
`CSSLab/maia-platform-frontend` `src/contexts/MaiaEngineContext.tsx`). It is the smallest/"simplified"
deployment build of Maia-3, per D-09.

### License

The model is a CSSLab artifact ("Chessformer" / Maia-3) licensed under **AGPL-3.0**. FlawChess is
AGPL-3.0-relicensed (v1.32). Only the model **data asset** is vendored — **no CSSLab source code**
(encoding/inference utilities, `MaiaEngineContext`, etc.) is copied. See the phase attribution
requirement LIC-02 for the visible-surface citation of the CSSLab repo, AGPL text, model artifact,
and the Chessformer paper (arXiv 2605.19091).

To re-verify the pin:

```bash
sha256sum frontend/public/maia/maia3_simplified.onnx
# 405bf76c15727dad8728b352c06a8f3c1b80fb2760e8d666b32485c63d75b856
```

## Runtime — WASM-CPU-only path: `ort.wasm.min.js` + `ort-wasm-simd-threaded.{mjs,wasm}`

The onnxruntime-web WASM (CPU) execution-provider runtime, vendored from the `onnxruntime-web`
npm package so the Worker can load it from a fixed path without bundler processing.

| Field | Value |
|-------|-------|
| Package | `onnxruntime-web` v1.27.0 (MIT, Microsoft — github.com/microsoft/onnxruntime) |
| Vendored files | `ort.wasm.min.js` (API bundle), `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` |
| Source | `node_modules/onnxruntime-web/dist/` |

`ort.wasm.min.js` is the WASM-only minified API bundle (`ort.InferenceSession`/`ort.Tensor`/
`ort.env`), loaded via `importScripts()` in the classic Maia Worker. It requests the base
SIMD+threaded WASM build (`ort-wasm-simd-threaded.{mjs,wasm}`, ~13.5 MB) at session-create time.
FlawChess runs it with `ort.env.wasm.numThreads = 1` forced (no cross-origin-isolation headers
site-wide — Phase 136 D-3, CI-guarded), so no `SharedArrayBuffer` is required. This is the
fallback path for browsers without WebGPU (D-09).

## Runtime — WebGPU-preferred path: `ort.webgpu.min.js` + `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`

| Field | Value |
|-------|-------|
| Package | `onnxruntime-web` v1.27.0 (MIT, Microsoft) |
| Vendored files | `ort.webgpu.min.js` (API bundle), `ort-wasm-simd-threaded.asyncify.mjs`, `ort-wasm-simd-threaded.asyncify.wasm` |
| Source | `node_modules/onnxruntime-web/dist/` |

`ort.webgpu.min.js` is the WebGPU+WASM API bundle. Feature-detected via
`navigator.gpu?.requestAdapter()` in `maia-worker.js`; when available, the Worker creates the
session with `executionProviders: ['webgpu']`, wrapped in a try/catch that falls back to the
WASM-only path above on ANY failure (no adapter, session-create failure, or an unsupported op —
RESEARCH.md Pitfall 4). `ort.env.wasm.numThreads` is forced to `1` on this path too, before any
session is created.

**Filename correction vs. earlier research:** 151-MAIA-CONTRACT.md's "Runtime facts" section
(written before this worker was implemented) expected a **JSEP** build
(`ort-wasm-simd-threaded.jsep.{mjs,wasm}`) for the WebGPU path. Direct inspection of the vendored
v1.27.0 `ort.webgpu.min.js` bundle (`grep` for the literal filename it requests) shows it actually
requires the **Asyncify** build (`ort-wasm-simd-threaded.asyncify.{mjs,wasm}`) instead — the JSEP
pair is used by other bundles (`ort.min.js`, `ort.all.min.js`), not this one. The asyncify pair is
vendored here; the JSEP pair was never added (unused by this worker's chosen bundle).

## Runtime binary ownership (Phase 213-09, G-213-35 second half)

As of Phase 213-09 the two `ort-wasm-simd-threaded*.wasm` binaries above are no
longer fetched by onnxruntime-web itself inside `InferenceSession.create()`.
The MAIN THREAD (`frontend/src/lib/engine/ortRuntimeSource.ts`) now probes the
WebGPU adapter's `shader-f16` feature BEFORE any Worker exists, chooses
exactly ONE of the two builds, streams that build's `.wasm` bytes with a
progress-reporting reader, and hands the resulting buffer to the worker at
spawn (`maiaWorkerHost.ts`) via `ort.env.wasm.wasmBinary`. The two `.mjs`
loaders and the two API bundles (`ort.wasm.min.js`, `ort.webgpu.min.js`)
remain worker-loaded via `importScripts()` exactly as before — only the large
`.wasm` binary moved.

**Bundle-to-binary pairing (verified by grepping each vendored bundle for the
literal filename it requests, per this file's "Filename correction" note
above):**

| API bundle | `.wasm` filename it requests | Size |
|---|---|---|
| `ort.wasm.min.js` (WASM-CPU-only) | `ort-wasm-simd-threaded.wasm` | 13,479,978 bytes |
| `ort.webgpu.min.js` (WebGPU-preferred) | `ort-wasm-simd-threaded.asyncify.wasm` | 24,254,953 bytes |

**Empirical `wasmBinary` suppression gate (213-09-PLAN.md Task 1 — verified
headlessly in Node, not by reading docs):** both vendored `.mjs` loaders
(`ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.asyncify.mjs`) were
copied into an isolated directory alongside the real vendored `.wasm` files,
driven directly under plain `node` with `fs.readFileSync` instrumented to
record every path read. Result for BOTH builds:

- **Without `wasmBinary` set:** exactly ONE read of the real `.wasm` file
  (baseline — confirms the loader does fetch/read the runtime binary when not
  given one).
- **With `wasmBinary` set to the real bytes:** ZERO reads of the `.wasm` file
  for either build.

This matches the source-level mechanism directly: both `.mjs` files assign
`Module.wasmBinary` into a closure variable (`q` in the wasm-only build, `sa`
in the asyncify build) the moment the factory runs, and BOTH the sync
binary-getter (`if(!q) ... await ha(a)`) and the streaming-instantiate path
(`if(!q && !isDataUri && !isNode) fetch(...)`) gate their read/fetch behind
that same variable being falsy. Setting `wasmBinary` therefore suppresses the
runtime binary fetch identically on the wasm-only AND the asyncify build —
there is no divergence between the two builds that would require keeping the
WebGPU path on `wasmPaths` resolution.

The `.mjs` loader itself (24-47 KB) is still resolved by onnxruntime-web via
`ort.env.wasm.wasmPaths` inside the worker — expected and negligible, not a
defect this change needs to prevent.

## Engine-asset CacheStorage layer (Phase 213-12, D-20)

As of Phase 213-12 all three engine assets — this model, the ORT runtime
binaries above, and the Stockfish `.wasm` (`public/engine/`) — resolve
through ONE byte-ownership layer backed by the browser's Cache API
(`frontend/src/lib/engine/engineAssetCache.ts`). The main thread reaches it
via `getEngineAsset()`; this worker (`maia-worker.js`, which cannot `import`
a TS module) reaches the SAME versioned cache by name, passed to it in the
`init` message's `assetCacheName` field rather than duplicated as a literal.

**Because none of these files are content-hashed, the cache-name version
constant IS the invalidation path.** Replacing any of the three engine asset
files (this model, either `ort-wasm-simd-threaded*.wasm` binary, or the
Stockfish `.wasm`) without bumping `ENGINE_ASSET_CACHE_VERSION` in
`engineAssetCache.ts` would leave every visiting browser reading the STALE
bytes out of CacheStorage indefinitely — worse than the HTTP cache below,
which self-heals after its 30-day `max-age`. **Bump
`ENGINE_ASSET_CACHE_VERSION` in the same commit as replacing any of these
files.** The next page load's cache-open sweeps every differently-versioned
`flawchess-engine-assets-*` cache away automatically.

## Cache headers

`deploy/Caddyfile` caches this directory's binaries (the `.onnx` model, `ort.wasm.min.js`,
`ort.webgpu.min.js`, and the `ort-wasm-simd-threaded*` `.mjs`/`.wasm` pairs) at
`Cache-Control: public, max-age=2592000` (30 days) — long enough that a returning mobile
visitor never re-downloads the 43.6 MB model on a slow link, short enough that bumping
`onnxruntime-web` here is picked up within 30 days with **no rename required**. This is
deliberately NOT `immutable`: these filenames are not content-hashed, and onnxruntime-web
resolves its own `.wasm`/`.mjs` filenames by appending them to `ort.env.wasm.wasmPaths =
'/maia/'` (`maia-worker.js`), so renaming a file without also versioning the directory would
break asset resolution.

`maia-worker.js` itself is the one exception: it is `Cache-Control: no-cache`, not 30-day
cached, because it is OUR source (not vendored) and its message protocol changes alongside
the content-hashed app bundle on every deploy — caching it long would let a fresh
`useMaiaEngine`/`maiaQueue` on a new deploy talk to a stale worker that has never heard of a
newer protocol message. See `deploy/Caddyfile`'s `@maiaworker`/`@vendored_runtime` matchers
for the exact rule (quick 260729-sod, FIX 4).

## PWA precache

`vite.config.ts` `workbox.globIgnores` excludes both `**/*.onnx` and `**/*.wasm` so neither the
model nor the ort runtime is Workbox-precached (they are served/cached via the HTTP cache instead;
the model alone would blow past the iOS Cache API ~50 MB limit). `optimizeDeps.exclude` includes
`onnxruntime-web` so esbuild never relocates its runtime and breaks the fixed asset path.
