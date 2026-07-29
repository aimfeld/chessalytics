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
