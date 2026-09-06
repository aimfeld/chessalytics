// @vitest-environment node
/**
 * maiaWorkerScript.test.ts — end-to-end sandbox test of the vendored
 * `frontend/public/maia/maia-worker.js` classic Worker script (Phase 213-09,
 * G-213-35).
 *
 * `maia-worker.js` is a classic (non-ESM, non-bundled) script served
 * verbatim, so it cannot be `import`ed by Vitest's module graph. This file
 * drives it directly via `node:vm`'s `runInContext` against a sandbox
 * supplying `self`, `fetch`, `importScripts`, `postMessage`, and `console` —
 * the same technique the repo already uses for headless vendored-bundle
 * verification (see 213-09-PLAN.md Task 1's `wasmBinary` gate and the
 * vendored README's "Runtime binary ownership" section).
 *
 * The fake `importScripts` records the requested path and installs a FAKE
 * `ort` global (an `env.wasm` object, a `Tensor` constructor, and an
 * `InferenceSession.create` resolving a session whose `run()` returns
 * plausibly-shaped `logits_move`/`logits_value` typed arrays) — this file's
 * job is the WORKER SCRIPT's own message-handling and `ort.env.wasm.*`
 * plumbing, not onnxruntime-web's real behavior (covered by the Task 1
 * empirical gate and `ortRuntimeSource.test.ts`).
 *
 * Deliberately avoids `instanceof`/`toBeInstanceOf` on any value the worker
 * script constructs INSIDE the sandbox (e.g. `new Uint8Array(runtimeBuffer)`
 * built with the sandbox's OWN realm-local `Uint8Array`): such values fail an
 * `instanceof` check against the outer (Node test) realm's constructor even
 * though they are genuine typed arrays. `ArrayBuffer.isView()` and
 * length/byte checks are realm-agnostic and used instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';

const WORKER_SCRIPT_PATH = fileURLToPath(new NodeURL('../../../../public/maia/maia-worker.js', import.meta.url));
const WORKER_SCRIPT_SOURCE = readFileSync(WORKER_SCRIPT_PATH, 'utf-8');

const WASM_ONLY_GLUE_PATH = '/maia/ort.wasm.min.js';
const WEBGPU_GLUE_PATH = '/maia/ort.webgpu.min.js';

const WARMUP_LOGITS_MOVE_SIZE = 4352; // POLICY_VOCAB_SIZE in maia-worker.js
const WARMUP_LOGITS_VALUE_SIZE = 3; // WDL_SIZE in maia-worker.js

interface CreateCall {
  wasmBinarySnapshot: unknown;
  executionProviders: string[];
  numThreadsAtCreate: number;
  /** WR-01 (Phase 219 review): `ort.env.wasm.initTimeout` as of create() time. */
  initTimeoutAtCreate: unknown;
}

interface SandboxHandle {
  sandbox: {
    self: Record<string, unknown>;
    onmessage?: (e: { data: Record<string, unknown> }) => Promise<void>;
    ort?: { env: { wasm: Record<string, unknown> } };
  };
  importScriptsCalls: string[];
  postMessages: Record<string, unknown>[];
  createCalls: CreateCall[];
  fetchCalls: string[];
  cacheStore: Map<string, Uint8Array>;
  cacheOpenCalls: string[];
}

const TEST_ASSET_CACHE_NAME = 'flawchess-engine-assets-v1';
const MODEL_PATH = '/maia/maia3_simplified.onnx';

/** Builds a fake onnxruntime-web `ort` global with an instrumented `InferenceSession.create`. */
function createFakeOrt(
  env: { wasm: Record<string, unknown> },
  onCreate: (snapshot: unknown, executionProviders: string[]) => void,
): { env: { wasm: Record<string, unknown> }; Tensor: unknown; InferenceSession: unknown } {
  function FakeTensor(this: Record<string, unknown>, type: string, data: unknown, dims: unknown): void {
    this.type = type;
    this.data = data;
    this.dims = dims;
    this.dispose = (): void => {};
  }
  return {
    env,
    Tensor: FakeTensor,
    InferenceSession: {
      create: async (
        _modelBuffer: unknown,
        opts: { executionProviders: string[] },
      ): Promise<{ run: (feeds: unknown) => Promise<Record<string, { data: Float32Array }>>; release: () => Promise<void> }> => {
        // Snapshot BEFORE returning — this is the moment the worker script has
        // already set `wasmBinary` (if it was going to) but has not yet
        // cleared it, mirroring exactly where a real onnxruntime-web
        // `InferenceSession.create` would read it.
        onCreate(env.wasm.wasmBinary, opts.executionProviders);
        return {
          run: async () =>
            Promise.resolve({
              logits_move: { data: new Float32Array(WARMUP_LOGITS_MOVE_SIZE) },
              logits_value: { data: new Float32Array(WARMUP_LOGITS_VALUE_SIZE) },
            }),
          release: async () => {},
        };
      },
    },
  };
}

/** A completed (zero-byte) fetch response — these tests don't care about real model bytes, only worker-script protocol correctness. */
function fakeFetchResponse(): {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => { read: () => Promise<{ done: boolean; value: undefined }> } };
} {
  return {
    ok: true,
    status: 200,
    headers: { get: () => '0' },
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  };
}

/** A completed fetch response carrying real bytes — used by the asset-cache tests below to prove the written body. `declaredLength` lets a test declare a content-length that differs from the delivered bytes (CR-01 truncation shape). */
function fakeFetchResponseWithBytes(
  bytes: Uint8Array,
  declaredLength?: number,
): {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } };
} {
  let delivered = false;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name === 'content-length' ? String(declaredLength ?? bytes.length) : null),
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

interface SetupSandboxOptions {
  /** Installs a `caches` double in the sandbox (jsdom-style feature availability). */
  withCaches?: boolean;
  /** Pre-populates the cache double's model entry — simulates "already downloaded". */
  seedModelBytes?: Uint8Array;
  /** Bytes the fetch stub returns on a model fetch — defaults to the pre-existing zero-byte response. */
  modelFetchBytes?: Uint8Array;
  /** Overrides the content-length the model fetch declares (CR-01: a value larger than modelFetchBytes.length simulates clean-EOF truncation). */
  modelFetchDeclaredLength?: number;
  /** Phase 219 (D-08): installs `self.crossOriginIsolated` — absent/false exercises `chooseWasmThreadCount()`'s fail-safe (returns 1 regardless of core count). */
  crossOriginIsolated?: boolean;
  /** Phase 219 (D-08): installs `self.navigator = { hardwareConcurrency }` — omitted entirely (no `navigator` at all) exercises the defensive `self.navigator && ...` read, the same as a `node:vm` sandbox with no navigator global. */
  hardwareConcurrency?: number;
}

/** Creates a fresh `node:vm` sandbox, runs the real vendored worker script inside it, and returns instrumentation handles. */
function setupSandbox(opts: SetupSandboxOptions = {}): SandboxHandle {
  const importScriptsCalls: string[] = [];
  const postMessages: Record<string, unknown>[] = [];
  const createCalls: CreateCall[] = [];
  const fetchCalls: string[] = [];
  const cacheStore = new Map<string, Uint8Array>();
  const cacheOpenCalls: string[] = [];
  const env: { wasm: Record<string, unknown> } = { wasm: {} };

  if (opts.seedModelBytes) {
    cacheStore.set(MODEL_PATH, opts.seedModelBytes);
  }

  const sandbox: SandboxHandle['sandbox'] = { self: {} };
  sandbox.self = sandbox as unknown as Record<string, unknown>; // `self` in a Worker IS the global scope
  (sandbox as unknown as Record<string, unknown>).console = console;
  // Phase 219 (D-08): `self.crossOriginIsolated` defaults to `undefined`
  // (falsy) — the same "no headers" starting point as every pre-existing
  // test in this file, all of which expect numThreadsAtCreate === 1.
  (sandbox as unknown as Record<string, unknown>).crossOriginIsolated = opts.crossOriginIsolated ?? false;
  // Absent entirely (not merely `undefined`-valued) when the option is not
  // provided, so the no-navigator defensive path in chooseWasmThreadCount()
  // keeps being exercised exactly as before this change.
  if (opts.hardwareConcurrency !== undefined) {
    (sandbox as unknown as Record<string, unknown>).navigator = { hardwareConcurrency: opts.hardwareConcurrency };
  }
  (sandbox as unknown as Record<string, unknown>).postMessage = (msg: Record<string, unknown>): void => {
    postMessages.push(msg);
  };
  (sandbox as unknown as Record<string, unknown>).importScripts = (path: string): void => {
    importScriptsCalls.push(path);
    sandbox.ort = createFakeOrt(env, (wasmBinarySnapshot, executionProviders) => {
      createCalls.push({
        wasmBinarySnapshot,
        executionProviders,
        numThreadsAtCreate: env.wasm.numThreads as number,
        initTimeoutAtCreate: env.wasm.initTimeout,
      });
    });
  };
  (sandbox as unknown as Record<string, unknown>).fetch = async (url: string) => {
    fetchCalls.push(url);
    return opts.modelFetchBytes
      ? fakeFetchResponseWithBytes(opts.modelFetchBytes, opts.modelFetchDeclaredLength)
      : fakeFetchResponse();
  };

  if (opts.withCaches) {
    // Real `Response` (Node's global, undici-backed) so the worker script's
    // own `new Response(buffer)` / `match.arrayBuffer()` calls behave exactly
    // as they would in a real browser Worker.
    (sandbox as unknown as Record<string, unknown>).Response = Response;
    (sandbox as unknown as Record<string, unknown>).caches = {
      open: async (name: string) => {
        cacheOpenCalls.push(name);
        return {
          match: async (url: string) => {
            const bytes = cacheStore.get(url);
            return bytes ? new Response(bytes) : undefined;
          },
          put: async (url: string, response: Response) => {
            const buf = await response.arrayBuffer();
            cacheStore.set(url, new Uint8Array(buf));
          },
        };
      },
    };
  }

  vm.createContext(sandbox as unknown as vm.Context);
  vm.runInContext(WORKER_SCRIPT_SOURCE, sandbox as unknown as vm.Context, { filename: 'maia-worker.js' });

  return { sandbox, importScriptsCalls, postMessages, createCalls, fetchCalls, cacheStore, cacheOpenCalls };
}

/** Dispatches a `type: 'init'` message and awaits the worker script's async handler. */
async function sendInit(handle: SandboxHandle, msg: Record<string, unknown>): Promise<void> {
  await handle.sandbox.onmessage!({ data: { type: 'init', ...msg } });
}

describe('maiaWorkerScript — backend: wasm', () => {
  let handle: SandboxHandle;

  beforeEach(() => {
    handle = setupSandbox();
  });

  it('imports ONLY the wasm-only glue — never the webgpu one', async () => {
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.importScriptsCalls).toEqual([WASM_ONLY_GLUE_PATH]);
  });

  it('sets numThreads to 1 BEFORE InferenceSession.create()', async () => {
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.createCalls).toHaveLength(1);
    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(1);
    expect(handle.createCalls[0]?.executionProviders).toEqual(['wasm']);
  });

  it('sets wasmBinary from a supplied runtimeBuffer, then clears it after create() returns', async () => {
    const runtimeBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
    await sendInit(handle, { backend: 'wasm', runtimeBuffer });

    // Snapshot taken INSIDE create() — the worker script must have already
    // set wasmBinary by this point.
    const snapshot = handle.createCalls[0]?.wasmBinarySnapshot;
    expect(ArrayBuffer.isView(snapshot)).toBe(true);
    expect((snapshot as Uint8Array).length).toBe(4);

    // After create() has fully returned and 'ready' has posted, wasmBinary
    // must be cleared — retaining the duplicate buffer past this point is
    // pure waste on the worker's heap (T-213-09-06).
    expect(handle.sandbox.ort?.env.wasm.wasmBinary).toBeUndefined();
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });

  it('an absent runtimeBuffer leaves wasmBinary unset throughout', async () => {
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.createCalls[0]?.wasmBinarySnapshot).toBeUndefined();
    expect(handle.sandbox.ort?.env.wasm.wasmBinary).toBeUndefined();
  });

  // NOTE (Phase 213-12, D-20): the "prefetched modelBuffer" handoff test
  // that used to live here (G-213-8) is RETIRED — that mechanism is gone.
  // The equivalent "already-complete progress, zero fetch" behavior is now
  // exercised via CacheStorage instead — see the "asset cache" describe
  // block below (`a populated cache: ZERO fetch calls...`).
});

describe('maiaWorkerScript — backend: webgpu', () => {
  let handle: SandboxHandle;

  beforeEach(() => {
    handle = setupSandbox();
  });

  it('imports ONLY the webgpu glue — never the wasm-only one', async () => {
    await sendInit(handle, { backend: 'webgpu' });

    expect(handle.importScriptsCalls).toEqual([WEBGPU_GLUE_PATH]);
  });

  it('sets numThreads to 1 BEFORE InferenceSession.create(), with the webgpu execution provider', async () => {
    await sendInit(handle, { backend: 'webgpu' });

    expect(handle.createCalls).toHaveLength(1);
    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(1);
    expect(handle.createCalls[0]?.executionProviders).toEqual(['webgpu']);
  });

  it('sets wasmBinary from a supplied runtimeBuffer, then clears it after create() succeeds and the warmup analyze() completes', async () => {
    const runtimeBuffer = new Uint8Array([9, 9, 9]).buffer;
    await sendInit(handle, { backend: 'webgpu', runtimeBuffer });

    const snapshot = handle.createCalls[0]?.wasmBinarySnapshot;
    expect(ArrayBuffer.isView(snapshot)).toBe(true);
    expect((snapshot as Uint8Array).length).toBe(3);

    expect(handle.sandbox.ort?.env.wasm.wasmBinary).toBeUndefined();
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'webgpu', numThreads: 1 });
  });

  it('an absent runtimeBuffer leaves wasmBinary unset throughout the webgpu path too', async () => {
    await sendInit(handle, { backend: 'webgpu' });

    expect(handle.createCalls[0]?.wasmBinarySnapshot).toBeUndefined();
    expect(handle.sandbox.ort?.env.wasm.wasmBinary).toBeUndefined();
  });
});

describe('maiaWorkerScript — chooseWasmThreadCount() (Phase 219, D-08)', () => {
  it('not cross-origin isolated: 1 thread regardless of core count', async () => {
    const handle = setupSandbox({ crossOriginIsolated: false, hardwareConcurrency: 16 });
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(1);
  });

  it.each([
    [1, 1],
    [2, 1],
    [7, 4], // ceiling on the halved core count first (4), then the MAIA_MAX_WASM_THREADS cap
    [8, 4],
    [9, 4], // the cap binds — half of 9 ceils to 5, capped to 4
  ])('isolated, hardwareConcurrency %i -> %i thread(s), wasm-only path', async (hardwareConcurrency, expected) => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency });
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(expected);
  });

  it('isolated, hardwareConcurrency undefined (no navigator at all): 1 thread — the defensive fallback', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true });
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(1);
  });

  it('isolated, hardwareConcurrency 8: the WebGPU/asyncify path uses the SAME formula as the wasm-only path', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency: 8 });
    await sendInit(handle, { backend: 'webgpu' });

    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(4);
  });

  it('the ready message carries the same numThreads that was assigned before create()', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency: 8 });
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 4 });
  });
});

describe('maiaWorkerScript — WR-01 (Phase 219 review): bounded threaded init + forceSingleThread', () => {
  it('sets ort.env.wasm.initTimeout to a bounded value BEFORE InferenceSession.create(), wasm-only path', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency: 8 });
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.createCalls[0]?.initTimeoutAtCreate).toBeGreaterThan(0);
  });

  it('sets ort.env.wasm.initTimeout to a bounded value BEFORE InferenceSession.create(), webgpu/asyncify path', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency: 8 });
    await sendInit(handle, { backend: 'webgpu' });

    expect(handle.createCalls[0]?.initTimeoutAtCreate).toBeGreaterThan(0);
  });

  it('forceSingleThread pins numThreads to 1 even when crossOriginIsolated + hardwareConcurrency would otherwise choose more, wasm-only path', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency: 8 });
    await sendInit(handle, { backend: 'wasm', forceSingleThread: true });

    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(1);
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });

  it('forceSingleThread pins numThreads to 1 on the webgpu/asyncify path too', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency: 8 });
    await sendInit(handle, { backend: 'webgpu', forceSingleThread: true });

    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(1);
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'webgpu', numThreads: 1 });
  });

  it('an absent forceSingleThread leaves chooseWasmThreadCount()\'s normal formula in effect (no regression)', async () => {
    const handle = setupSandbox({ crossOriginIsolated: true, hardwareConcurrency: 8 });
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.createCalls[0]?.numThreadsAtCreate).toBe(4);
  });
});

describe('maiaWorkerScript — backend defaulting', () => {
  it('an unrecognised backend value falls safe to wasm (D-13 fail-safe-toward-wasm philosophy)', async () => {
    const handle = setupSandbox();
    await sendInit(handle, { backend: 'not-a-real-backend' });

    expect(handle.importScriptsCalls).toEqual([WASM_ONLY_GLUE_PATH]);
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });

  it('an absent backend field falls safe to wasm', async () => {
    const handle = setupSandbox();
    await sendInit(handle, {});

    expect(handle.importScriptsCalls).toEqual([WASM_ONLY_GLUE_PATH]);
  });
});

describe('maiaWorkerScript — asset cache (Phase 213-12, D-20, closing G-213-37)', () => {
  it('a populated cache: ZERO fetch calls, one complete progress event, and ready posted', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const handle = setupSandbox({ withCaches: true, seedModelBytes: bytes });

    await sendInit(handle, { backend: 'wasm', assetCacheName: TEST_ASSET_CACHE_NAME });

    expect(handle.fetchCalls).toEqual([]); // zero network — the model came from the cache
    expect(handle.cacheOpenCalls).toEqual([TEST_ASSET_CACHE_NAME]);
    const progressEvents = handle.postMessages.filter((m) => m.type === 'progress');
    expect(progressEvents).toEqual([{ type: 'progress', loaded: bytes.length, total: bytes.length }]);
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });

  it('an EMPTY cache: exactly one model fetch, and the complete body is written to the cache under MODEL_PATH', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const handle = setupSandbox({ withCaches: true, modelFetchBytes: bytes });

    await sendInit(handle, { backend: 'wasm', assetCacheName: TEST_ASSET_CACHE_NAME });

    expect(handle.fetchCalls).toEqual([MODEL_PATH]);
    expect(handle.cacheOpenCalls).toEqual([TEST_ASSET_CACHE_NAME]);
    const stored = handle.cacheStore.get(MODEL_PATH);
    expect(stored).toBeDefined();
    expect(Array.from(stored!)).toEqual(Array.from(bytes));
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });

  it('NO assetCacheName: byte-for-byte todays behavior — one fetch, no cache access at all, even when caches IS available', async () => {
    const handle = setupSandbox({ withCaches: true }); // caches available, but no name given
    await sendInit(handle, { backend: 'wasm' });

    expect(handle.fetchCalls).toEqual([MODEL_PATH]);
    expect(handle.cacheOpenCalls).toEqual([]); // never opened — no assetCacheName means no cache access
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });

  it('a model stream ending short of its declared content-length is retried and NEVER written to the cache (CR-01)', async () => {
    // Clean-EOF truncation: 3 bytes delivered against a declared 5. The
    // worker must treat this as a failed download (engaging the D-15 retry
    // loop), and the truncated body must never reach the cache — a cached
    // truncated model would be served back as complete on every later spawn.
    const bytes = new Uint8Array([9, 8, 7]);
    const handle = setupSandbox({ withCaches: true, modelFetchBytes: bytes, modelFetchDeclaredLength: 5 });

    await sendInit(handle, { backend: 'wasm', assetCacheName: TEST_ASSET_CACHE_NAME });

    expect(handle.fetchCalls).toEqual([MODEL_PATH, MODEL_PATH]); // both MODEL_FETCH_ATTEMPTS consumed
    expect(handle.cacheStore.has(MODEL_PATH)).toBe(false);
    expect(handle.postMessages.some((m) => m.type === 'error')).toBe(true);
    expect(handle.postMessages.some((m) => m.type === 'ready')).toBe(false);
  });

  it('a model response with no usable content-length resolves but is NOT cached — the next spawn fetches again (CR-01)', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    // declaredLength 0 → the worker's Number(...) coercion falls back, so the
    // length is unverifiable: return the bytes, skip the cache write.
    const handle = setupSandbox({ withCaches: true, modelFetchBytes: bytes, modelFetchDeclaredLength: 0 });

    await sendInit(handle, { backend: 'wasm', assetCacheName: TEST_ASSET_CACHE_NAME });

    expect(handle.fetchCalls).toEqual([MODEL_PATH]);
    expect(handle.cacheStore.has(MODEL_PATH)).toBe(false);
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });

  it('assetCacheName present but caches undefined (Safari private mode / insecure context): degrades to a plain fetch, never throws', async () => {
    const handle = setupSandbox(); // withCaches NOT set — caches is undefined in this sandbox
    await sendInit(handle, { backend: 'wasm', assetCacheName: TEST_ASSET_CACHE_NAME });

    expect(handle.fetchCalls).toEqual([MODEL_PATH]);
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
    expect(handle.postMessages.some((m) => m.type === 'error')).toBe(false);
  });
});

// ─── Asset versioning (quick 260905-rhc) ───────────────────────────────────
//
// Reads the URLs the sandboxed worker ACTUALLY passed to importScripts,
// fetch, cache.put, and ort.env.wasm.wasmPaths — behavioral evidence, not a
// grep for `versionedAssetUrl` in the worker source (Proof obligation).

const TEST_VERSION_QUERY = '?v=42';

describe('maiaWorkerScript — asset versioning (quick 260905-rhc)', () => {
  it('wasm backend: importScripts, the model fetch/cache key, and wasmPaths (wasm-only pair) all carry the version suffix', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = setupSandbox({ withCaches: true, modelFetchBytes: bytes });

    await sendInit(handle, {
      backend: 'wasm',
      assetCacheName: TEST_ASSET_CACHE_NAME,
      assetVersionQuery: TEST_VERSION_QUERY,
    });

    expect(handle.importScriptsCalls).toEqual([`${WASM_ONLY_GLUE_PATH}${TEST_VERSION_QUERY}`]);
    expect(handle.fetchCalls).toEqual([`${MODEL_PATH}${TEST_VERSION_QUERY}`]);
    expect(handle.cacheStore.has(`${MODEL_PATH}${TEST_VERSION_QUERY}`)).toBe(true);
    expect(handle.cacheStore.has(MODEL_PATH)).toBe(false);

    const wasmPaths = handle.sandbox.ort?.env.wasm.wasmPaths as { mjs: string; wasm: string };
    expect(wasmPaths.mjs.endsWith(TEST_VERSION_QUERY)).toBe(true);
    expect(wasmPaths.wasm.endsWith(TEST_VERSION_QUERY)).toBe(true);
    expect(wasmPaths.mjs).toContain('ort-wasm-simd-threaded.mjs');
    expect(wasmPaths.wasm).toContain('ort-wasm-simd-threaded.wasm');
    expect(wasmPaths.mjs).not.toContain('asyncify');
  });

  it('webgpu backend: importScripts and wasmPaths (asyncify pair) carry the version suffix', async () => {
    const handle = setupSandbox();

    await sendInit(handle, { backend: 'webgpu', assetVersionQuery: TEST_VERSION_QUERY });

    expect(handle.importScriptsCalls).toEqual([`${WEBGPU_GLUE_PATH}${TEST_VERSION_QUERY}`]);

    const wasmPaths = handle.sandbox.ort?.env.wasm.wasmPaths as { mjs: string; wasm: string };
    expect(wasmPaths.mjs.endsWith(TEST_VERSION_QUERY)).toBe(true);
    expect(wasmPaths.wasm.endsWith(TEST_VERSION_QUERY)).toBe(true);
    expect(wasmPaths.mjs).toContain('ort-wasm-simd-threaded.asyncify.mjs');
    expect(wasmPaths.wasm).toContain('ort-wasm-simd-threaded.asyncify.wasm');
  });

  it('an absent assetVersionQuery degrades to unversioned URLs on every one of those surfaces — the worker still initialises', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = setupSandbox({ withCaches: true, modelFetchBytes: bytes });

    await sendInit(handle, { backend: 'wasm', assetCacheName: TEST_ASSET_CACHE_NAME });

    expect(handle.importScriptsCalls).toEqual([WASM_ONLY_GLUE_PATH]);
    expect(handle.fetchCalls).toEqual([MODEL_PATH]);
    expect(handle.cacheStore.has(MODEL_PATH)).toBe(true);
    const wasmPaths = handle.sandbox.ort?.env.wasm.wasmPaths as { mjs: string; wasm: string };
    expect(wasmPaths.mjs).toBe('/maia/ort-wasm-simd-threaded.mjs');
    expect(wasmPaths.wasm).toBe('/maia/ort-wasm-simd-threaded.wasm');
    expect(handle.postMessages).toContainEqual({ type: 'ready', backend: 'wasm', numThreads: 1 });
  });
});
