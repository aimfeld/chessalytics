/**
 * ortRuntimeSource — the single main-thread owner of the onnxruntime-web
 * runtime `.wasm` binary (Phase 213-09, G-213-35 second half).
 *
 * Bug fix: today onnxruntime-web fetches its own runtime binary INSIDE
 * `InferenceSession.create()`, resolved off `ort.env.wasm.wasmPaths =
 * '/maia/'` in the worker. That fetch never touches a streaming reader, posts
 * no progress, and has no asset id — 13.5 MB (wasm-only) or 24.3 MB
 * (WebGPU/asyncify) transfers with the gate's bar showing nothing. Worse, on
 * a device whose WebGPU adapter lacks the `shader-f16` feature the worker
 * used to fetch the WebGPU build, fail its D-14 warmup `analyze()`, and THEN
 * fetch the wasm-only build too — 37.8 MB to end up exactly where a straight
 * wasm boot would have started (see 213-09-PLAN.md's objective).
 *
 * This module moves both decisions to the main thread, BEFORE any Worker is
 * constructed: it inspects the WebGPU adapter's advertised feature set to
 * choose exactly ONE build, then resolves that build's bytes through
 * `engineAssetCache.ts`'s `getEngineAsset()` — the same cache-first layer
 * every engine asset now shares (D-20) — reporting every chunk under the
 * `ort-runtime` asset id, and hands the resulting buffer to the worker at
 * spawn (`maiaWorkerHost`, Task 2) for `ort.env.wasm.wasmBinary`.
 * onnxruntime-web then issues NO runtime request of its own — see this
 * file's Task 1 gate finding below for the empirical proof that `wasmBinary`
 * actually suppresses that fetch.
 *
 * Empirical `wasmBinary` gate (213-09-PLAN.md Task 1, run headlessly in
 * Node against the real vendored `.mjs` loaders with `fs.readFileSync`
 * instrumented — see the vendored README's "Runtime binary ownership"
 * section for the full method and result): setting `wasmBinary` on the
 * Emscripten module factory suppresses the runtime `.wasm` file read/fetch
 * for BOTH builds. Baseline (no `wasmBinary`): exactly one `.wasm` read for
 * each build. With `wasmBinary` set to the real bytes: ZERO `.wasm` reads for
 * either build. The `.mjs` loader itself is still resolved by onnxruntime-web
 * via `wasmPaths` in the worker (24-47 KB) — expected and negligible, not a
 * defect this module needs to prevent.
 *
 * D-08: the fetch is triggered ONLY at the spawn seam that already exists
 * (`maiaWorkerHost.ts`'s `ensureSpawned()`/`spawn()`, Task 2) — nothing is
 * fetched at import time and nothing is fetched speculatively.
 *
 * A failed fetch (network error, non-ok response, absent body) must never be
 * able to break engine spawn: `ensureOrtRuntime()` NEVER rejects — every
 * failure mode resolves `{ backend, buffer: null }`, reported once to Sentry.
 * A `null` buffer makes the caller spawn the worker with `wasmBinary` simply
 * left unset, so onnxruntime-web resolves the binary from `wasmPaths` exactly
 * as it does today (T-213-09-02).
 */

import * as Sentry from '@sentry/react';
import { markEngineAssetPending, reportEngineAssetProgress } from './engineAssetProgress';
import { getEngineAsset } from './engineAssetCache';

// ─── Named constants (CLAUDE.md no-magic-numbers) ──────────────────────────

/** Path to the WASM-CPU-only runtime binary served from public/maia/ — pairs with `ort.wasm.min.js` (confirmed by grepping the vendored bundle for the literal filename it requests; see the vendored README). */
export const ORT_RUNTIME_WASM_ONLY_PATH = '/maia/ort-wasm-simd-threaded.wasm';

/** Path to the WebGPU/asyncify runtime binary served from public/maia/ — pairs with `ort.webgpu.min.js`, NOT the `.jsep` pair some onnxruntime-web docs reference for other bundle combinations (confirmed the same way; see the vendored README's "Filename correction" note). */
export const ORT_RUNTIME_ASYNCIFY_PATH = '/maia/ort-wasm-simd-threaded.asyncify.wasm';

/** Raw byte size of the wasm-only runtime binary, verified live 2026-08-28. Defense-in-depth fallback for a missing/garbage `Content-Length`, mirroring `engineAssetProgress.ts`'s existing fallback constants. */
export const ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK = 13_479_978;

/** Raw byte size of the WebGPU/asyncify runtime binary, verified live 2026-08-28. */
export const ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK = 24_254_953;

/**
 * The WebGPU adapter feature Maia's fp16 graph needs for its Cast nodes. Bug
 * fix: without probing this BEFORE constructing a Worker, an adapter lacking
 * it only surfaced the failure inside the worker's D-14 warmup `analyze()` —
 * after the full 24.3 MB asyncify build had already been fetched, with a
 * second 13.5 MB wasm-only fetch still to come on respawn. Named per
 * CLAUDE.md's no-magic-numbers rule (a magic string from a fixed set is the
 * same violation as a bare numeric literal at the branch).
 */
const REQUIRED_WEBGPU_FEATURE = 'shader-f16';

/** The single engine-asset id this whole module reports under — `engineAssetCache.ts`'s single-flight and CacheStorage entries are keyed by this id, matching `engineAssetProgress.ts`'s own `EngineAssetId` union member. */
const ORT_RUNTIME_ASSET_ID = 'ort-runtime';

// ─── Types ──────────────────────────────────────────────────────────────────

export type OrtBackend = 'webgpu' | 'wasm';

export interface OrtRuntimeResult {
  backend: OrtBackend;
  /** `null` when the fetch failed for any reason — caller must degrade to onnxruntime-web's own `wasmPaths` resolution rather than treating this as fatal. */
  buffer: ArrayBuffer | null;
}

/** Minimal local shape for the WebGPU adapter surface this module reads — no `@webgpu/types` dependency (CLAUDE.md: no new package-manager installs without a plan-scoped reason). */
interface MinimalGpuAdapter {
  features?: { has?: (feature: string) => boolean } | null;
}

interface MinimalGpu {
  requestAdapter: () => Promise<MinimalGpuAdapter | null>;
}

// ─── Module-level singleton state ──────────────────────────────────────────

/**
 * Memoised so the WebGPU adapter probe runs exactly ONCE per page session —
 * WebGPU availability cannot change mid-session, so every later
 * `ensureOrtRuntime()` call reuses this same backend decision. Deliberately
 * does NOT memoise the runtime BYTES: `engineAssetCache.ts`'s
 * `getEngineAsset()` owns that (cache-first, single-flight, fresh instance
 * per caller) and is called fresh on every `ensureOrtRuntime()` invocation.
 *
 * Phase 213-12 (D-20, G-213-36 mechanism moved): before this fix, the
 * fetched `ArrayBuffer` was itself memoised inside this promise and handed
 * DIRECTLY to every caller. `maiaWorkerHost.ts`'s `constructWorker` pushes
 * that buffer into `postMessage`'s transfer list, which DETACHES it — so the
 * first worker's spawn silently consumed the ONE buffer this promise would
 * ever resolve, and every later caller (in practice: the ordinary
 * /analysis -> /bots navigation) received the SAME now-detached instance,
 * producing `DataCloneError: ArrayBuffer at index 0 is already detached`
 * inside a `.then()` as an unhandled rejection. 213-11 fixed this with a
 * retained, never-transferred master plus a per-call `slice(0)` copy — this
 * plan supersedes that mechanism: `getEngineAsset()`'s cache-first design
 * makes retain-and-copy unnecessary, because every call already resolves an
 * independent instance (a fresh cache read, or a fresh copy of a
 * single-flight join) with no ArrayBuffer EVER retained in this module's own
 * scope between calls.
 */
let backendPromise: Promise<OrtBackend> | null = null;

// ─── Backend selection ──────────────────────────────────────────────────────

/**
 * Inspects the WebGPU adapter's advertised feature set to choose exactly ONE
 * runtime build, entirely on the main thread and before any Worker exists.
 * Every malformed/absent shape falls safe to `'wasm'` — the wasm path always
 * works, and a wrong "present" answer is precisely the 24.3 MB defect this
 * module fixes (a wrong "absent" answer only costs GPU inference on that
 * device, never a second download):
 *  - no `navigator.gpu` at all (older/non-Chromium browsers)
 *  - `requestAdapter()` resolving `null` (no adapter available)
 *  - `requestAdapter()` rejecting
 *  - an adapter exposing no `features` set
 *  - a `features` object whose `.has` is not a function
 *  - a `.has()` call that throws
 * Never throws — the whole body is wrapped in one try/catch.
 */
async function probeOrtBackend(): Promise<OrtBackend> {
  try {
    const gpu = (navigator as Navigator & { gpu?: MinimalGpu }).gpu;
    if (!gpu) return 'wasm';
    const adapter = await gpu.requestAdapter();
    if (!adapter) return 'wasm';
    const features = adapter.features;
    if (!features || typeof features.has !== 'function') return 'wasm';
    return features.has(REQUIRED_WEBGPU_FEATURE) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/** Resolves the (url, fallbackBytes) pair for a chosen backend — the two builds have different URLs, so they are naturally distinct cache keys and cannot collide. */
function runtimeAssetFor(backend: OrtBackend): { url: string; fallbackBytes: number } {
  return backend === 'webgpu'
    ? { url: ORT_RUNTIME_ASYNCIFY_PATH, fallbackBytes: ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK }
    : { url: ORT_RUNTIME_WASM_ONLY_PATH, fallbackBytes: ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK };
}

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * The single owner of the onnxruntime-web runtime resolution. Memoised at
 * the BACKEND level only (the first call synchronously registers
 * `'ort-runtime'` as pending — CR-02, this MUST happen before the adapter
 * probe or the fetch, in the same synchronous call as the caller's
 * `markEngineAssetPending('maia-model')`, Task 2 — and starts the async
 * probe; every later call joins the same backend decision). The runtime
 * BYTES are resolved fresh on EVERY call via `getEngineAsset()`, which owns
 * its own cache-first + single-flight + fresh-instance-per-caller guarantee
 * — see `engineAssetCache.ts`.
 *
 * NEVER rejects — a failed probe or fetch resolves `{ backend, buffer: null
 * }` instead (defaults `backend` to `'wasm'` if even the probe itself somehow
 * threw past its own internal try/catch), so the caller degrades to
 * onnxruntime-web's own `wasmPaths` resolution rather than breaking spawn.
 */
export function ensureOrtRuntime(): Promise<OrtRuntimeResult> {
  if (!backendPromise) {
    // CR-02: registered synchronously, before the adapter probe (itself
    // async) even begins — this happens in the exact same tick as the first
    // caller's request.
    markEngineAssetPending(ORT_RUNTIME_ASSET_ID);
    backendPromise = probeOrtBackend();
  }

  return backendPromise.then(async (backend): Promise<OrtRuntimeResult> => {
    const { url, fallbackBytes } = runtimeAssetFor(backend);
    try {
      const buffer = await getEngineAsset(
        ORT_RUNTIME_ASSET_ID,
        url,
        (loaded, total) => reportEngineAssetProgress(ORT_RUNTIME_ASSET_ID, loaded, total),
        fallbackBytes,
      );
      return { backend, buffer };
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'ort-runtime-source', backend },
      });
      return { backend, buffer: null };
    }
  });
}

/**
 * Fetches the wasm-only runtime binary directly, bypassing the adapter probe
 * entirely and NOT joining `ensureOrtRuntime()`'s memoised BACKEND decision.
 * Used exclusively by `maiaWorkerHost.ts`'s `respawnPinnedToWasm()` (Task 2):
 * the host already knows the replacement worker is pinned to wasm (a WebGPU
 * session just failed), so there is no adapter left to probe, and the
 * replacement needs the wasm-only binary regardless of whatever
 * `ensureOrtRuntime()` already resolved. The caller is responsible for
 * calling `resetEngineAssetForRefetch('ort-runtime')` first so a genuinely
 * different binary (the replacement always follows a WebGPU/asyncify
 * attempt) is counted honestly rather than the gate's bar staying at the
 * first build's already-`done` state.
 *
 * NEVER rejects — mirrors `ensureOrtRuntime()`'s degrade-to-null contract so
 * a failed respawn fetch still lets the replacement worker spawn (with
 * `wasmBinary` left unset) rather than stranding the respawn.
 *
 * Routes through the SAME `getEngineAsset()` layer as `ensureOrtRuntime()`
 * (Phase 213-12, D-20): a respawn's binary is now a genuine CACHE READ when
 * this exact URL was already fetched earlier in the page session (e.g. a
 * SECOND wasm-pinned respawn, or a wasm-only backend that later needs this
 * same binary again) — an improvement over the pre-D-20 behavior, not a
 * behavior change to the caller's contract: this function still returns an
 * instance no other reader has touched, and it still does not share
 * `ensureOrtRuntime()`'s backend memoisation.
 */
export function fetchWasmOnlyOrtRuntime(): Promise<ArrayBuffer | null> {
  return getEngineAsset(
    ORT_RUNTIME_ASSET_ID,
    ORT_RUNTIME_WASM_ONLY_PATH,
    (loaded, total) => reportEngineAssetProgress(ORT_RUNTIME_ASSET_ID, loaded, total),
    ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK,
  ).catch((err: unknown) => {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { source: 'ort-runtime-source', backend: 'wasm' },
    });
    return null;
  });
}

/** Test-only: clears the memoised backend decision so each vitest case starts clean. */
export function resetOrtRuntimeSourceForTests(): void {
  backendPromise = null;
}
