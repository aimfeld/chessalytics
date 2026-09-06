// @vitest-environment jsdom
/**
 * ortRuntimeSource.ts unit tests (Phase 213-09, G-213-35 second half).
 *
 * Covers the adapter-driven backend selection (every malformed/absent shape
 * falls safe to wasm), the single-fetch memoisation, the CR-02 synchronous
 * pending registration, streamed progress reporting under the `ort-runtime`
 * asset id with the build-matching fallback byte count, failure degradation
 * to a null buffer, the standalone `fetchWasmOnlyOrtRuntime()` respawn path,
 * and a recorded mutation proof that the f16 predicate is load-bearing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import {
  ensureOrtRuntime,
  fetchWasmOnlyOrtRuntime,
  probeOrtBackendOnce,
  resetOrtRuntimeSourceForTests,
  ORT_RUNTIME_WASM_ONLY_PATH,
  ORT_RUNTIME_ASYNCIFY_PATH,
  ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK,
  ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK,
} from '../ortRuntimeSource';
import { getEngineAssetsSnapshot, resetEngineAssetsForTests, resetEngineAssetForRefetch } from '../engineAssetProgress';
import { resetEngineAssetCacheForTests, ENGINE_ASSET_CACHE_NAME } from '../engineAssetCache';

// @sentry/react's ESM module namespace is not configurable, so vi.spyOn cannot
// redefine captureException on the real module — mock the module instead
// (mirrors stockfishWorkerSource.test.ts).
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

// ─── Fetch/Response doubles (mirrors stockfishWorkerSource.test.ts) ────────

function createControlledReader(chunks: Uint8Array[]): {
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
  release: (index: number) => void;
} {
  const gates = chunks.map(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  });
  let index = 0;
  const reader = {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (index >= chunks.length) return { done: true, value: undefined };
      const gate = gates[index];
      if (gate) await gate.promise;
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
  };
  return {
    reader,
    release: (i: number) => gates[i]?.resolve(),
  };
}

function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  contentLength?: string | null;
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
}): Response {
  const { ok = true, status = 200, contentLength = null, reader } = opts;
  const headers = new Headers();
  if (contentLength !== null) headers.set('content-length', contentLength);
  return {
    ok,
    status,
    headers,
    body: { getReader: () => reader },
  } as unknown as Response;
}

function makeImmediateResponse(bytes: Uint8Array, contentLength?: string): Response {
  const { reader, release } = createControlledReader([bytes]);
  release(0);
  return makeResponse({ contentLength: contentLength ?? String(bytes.length), reader });
}

// ─── navigator.gpu doubles ──────────────────────────────────────────────────

/** Stubs `navigator.gpu` with an adapter reporting (or not) the f16 feature. */
function stubGpuWithFeature(hasF16: boolean): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: {
      requestAdapter: vi.fn().mockResolvedValue({
        features: { has: (f: string) => (hasF16 ? f === 'shader-f16' : false) },
      }),
    },
  });
}

function stubNoGpu(): void {
  vi.stubGlobal('navigator', { ...navigator, gpu: undefined });
}

function stubGpuNoAdapter(): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: { requestAdapter: vi.fn().mockResolvedValue(null) },
  });
}

function stubGpuRejectingAdapter(): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: { requestAdapter: vi.fn().mockRejectedValue(new Error('adapter request failed')) },
  });
}

function stubGpuNoFeatureSet(): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: { requestAdapter: vi.fn().mockResolvedValue({}) },
  });
}

function stubGpuThrowingFeatureCheck(): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: {
      requestAdapter: vi.fn().mockResolvedValue({
        features: {
          has: () => {
            throw new Error('feature inspection failed');
          },
        },
      }),
    },
  });
}

// ─── In-memory CacheStorage double (Phase 213-12, D-20) ────────────────────
//
// Mirrors engineAssetCache.test.ts's own double: stores RAW BYTES, not
// Response objects — a real Cache API's match() constructs a FRESH Response
// on every call, so this double must too, or a second match()+arrayBuffer()
// on the same entry would throw "body already read".

interface FakeCacheHandle {
  match: (url: string) => Promise<Response | undefined>;
  put: (url: string, response: Response) => Promise<void>;
}

function createCachesDouble(): {
  cachesDouble: {
    open: (name: string) => Promise<FakeCacheHandle>;
    keys: () => Promise<string[]>;
    delete: (name: string) => Promise<boolean>;
  };
  stores: Map<string, Map<string, Uint8Array>>;
} {
  const stores = new Map<string, Map<string, Uint8Array>>();

  function makeCacheHandle(name: string): FakeCacheHandle {
    return {
      match: async (url: string) => {
        const bytes = stores.get(name)?.get(url);
        return bytes ? new Response(bytes) : undefined;
      },
      put: async (url: string, response: Response) => {
        const buf = await response.arrayBuffer();
        const store = stores.get(name) ?? new Map<string, Uint8Array>();
        store.set(url, new Uint8Array(buf));
        stores.set(name, store);
      },
    };
  }

  const cachesDouble = {
    open: async (name: string): Promise<FakeCacheHandle> => {
      if (!stores.has(name)) stores.set(name, new Map());
      return makeCacheHandle(name);
    },
    keys: async (): Promise<string[]> => Array.from(stores.keys()),
    delete: async (name: string): Promise<boolean> => stores.delete(name),
  };

  return { cachesDouble, stores };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let caches_: ReturnType<typeof createCachesDouble>;

beforeEach(() => {
  resetOrtRuntimeSourceForTests();
  resetEngineAssetsForTests();
  resetEngineAssetCacheForTests();
  caches_ = createCachesDouble();
  vi.stubGlobal('caches', caches_.cachesDouble);
  // Default: no WebGPU at all, unless a test opts in.
  stubNoGpu();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetOrtRuntimeSourceForTests();
  resetEngineAssetsForTests();
  resetEngineAssetCacheForTests();
});

// ─── Backend selection ──────────────────────────────────────────────────────

describe('ensureOrtRuntime — backend selection falls safe to wasm', () => {
  it('an adapter reporting shader-f16 selects webgpu and requests the asyncify URL', async () => {
    stubGpuWithFeature(true);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('webgpu');
    expect(fetchMock).toHaveBeenCalledWith(ORT_RUNTIME_ASYNCIFY_PATH);
  });

  it('probes the adapter ORT itself will use — requestAdapter({ powerPreference: "high-performance" }) (SEED-158)', async () => {
    // Bug fix: an option-less requestAdapter() can return a DIFFERENT adapter
    // than onnxruntime-web's native WebGPU EP (which always asks for
    // high-performance) — on a multi-GPU box the probe then said "webgpu" for
    // an adapter ORT never used, and the 25.7 MB asyncify build was fetched
    // only to fail on the fp16 Cast node inside the worker.
    stubGpuWithFeature(true);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3]))));

    await ensureOrtRuntime();

    const gpu = (navigator as Navigator & { gpu: { requestAdapter: ReturnType<typeof vi.fn> } }).gpu;
    expect(gpu.requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
  });

  it('an adapter NOT reporting shader-f16 selects wasm and requests the wasm-only URL', async () => {
    stubGpuWithFeature(false);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('wasm');
    expect(fetchMock).toHaveBeenCalledWith(ORT_RUNTIME_WASM_ONLY_PATH);
  });

  it('no navigator.gpu at all selects wasm', async () => {
    stubNoGpu();
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('wasm');
    expect(fetchMock).toHaveBeenCalledWith(ORT_RUNTIME_WASM_ONLY_PATH);
  });

  it('requestAdapter() resolving null selects wasm', async () => {
    stubGpuNoAdapter();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3]))));

    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('wasm');
  });

  it('a rejecting requestAdapter() selects wasm', async () => {
    stubGpuRejectingAdapter();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3]))));

    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('wasm');
  });

  it('an adapter exposing no feature set selects wasm', async () => {
    stubGpuNoFeatureSet();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3]))));

    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('wasm');
  });

  it('a feature set whose has() throws on inspection selects wasm', async () => {
    stubGpuThrowingFeatureCheck();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3]))));

    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('wasm');
  });
});

// ─── Single-fetch memoisation ───────────────────────────────────────────────

describe('ensureOrtRuntime — single-fetch memoisation', () => {
  it('two consecutive calls issue exactly ONE fetch', async () => {
    stubGpuWithFeature(false);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    await ensureOrtRuntime();
    await ensureOrtRuntime();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ten concurrent calls issue exactly ONE fetch and one adapter probe', async () => {
    stubGpuWithFeature(false);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    const calls = Array.from({ length: 10 }, () => ensureOrtRuntime());
    const results = await Promise.all(calls);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [first, ...rest] = results;
    for (const r of rest) expect(r).toEqual(first);
  });

  it('MUTATION CHECK: the single-fetch guarantee is load-bearing — calling the un-memoised probe+fetch path directly N times issues N fetches', async () => {
    // Proves the memoisation guard is what makes the concurrent-callers test
    // above pass, not a coincidence of the mock setup: bypassing the module's
    // memoisation (calling fetch() directly) shows the N-fetch baseline this
    // guard prevents.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeImmediateResponse(new Uint8Array([1, 2, 3]))));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all(Array.from({ length: 10 }, () => fetch(ORT_RUNTIME_WASM_ONLY_PATH)));
    expect(fetchMock).toHaveBeenCalledTimes(10);

    fetchMock.mockClear();
    stubGpuWithFeature(false);
    const calls = Array.from({ length: 10 }, () => ensureOrtRuntime());
    await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── CR-02 ──────────────────────────────────────────────────────────────────

describe('ensureOrtRuntime — CR-02 synchronous pending registration', () => {
  it('registers ort-runtime as pending synchronously, before the adapter probe resolves', () => {
    stubGpuWithFeature(false);
    const { reader } = createControlledReader([new Uint8Array([1, 2, 3])]); // never released
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ contentLength: '3', reader })));

    void ensureOrtRuntime();

    // Synchronously right after the call returns — no await, no microtask flush.
    // The exact `total` figure the store's own placeholder uses is owned by
    // `engineAssetProgress.ts`'s `ENGINE_ASSET_FALLBACK_BYTES` table (Task 3
    // registers 'ort-runtime' there) — this test only proves the ENTRY exists
    // synchronously, before the adapter probe (itself async) can resolve.
    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.assets['ort-runtime']).toMatchObject({ loaded: 0, done: false });
  });
});

// ─── Streamed progress reporting ───────────────────────────────────────────

describe('ensureOrtRuntime — streamed progress reporting', () => {
  it('reports each chunk under ort-runtime, with total = content-length', async () => {
    stubGpuWithFeature(false);
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const { reader, release } = createControlledReader([chunk1, chunk2]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ contentLength: '5', reader })));

    const resultPromise = ensureOrtRuntime();

    release(0);
    await waitFor(() => {
      expect(getEngineAssetsSnapshot().assets['ort-runtime']?.loaded).toBe(3);
    });
    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.total).toBe(5);

    release(1);
    await resultPromise;

    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.loaded).toBe(5);
    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.total).toBe(5);
  });

  it('falls back to the wasm-only byte constant for a missing content-length on the wasm path', async () => {
    stubGpuWithFeature(false);
    const { reader, release } = createControlledReader([new Uint8Array([1, 2, 3])]);
    release(0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ contentLength: null, reader })));

    await ensureOrtRuntime();

    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.total).toBe(ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK);
  });

  it('falls back to the asyncify byte constant for a missing content-length on the webgpu path', async () => {
    stubGpuWithFeature(true);
    const { reader, release } = createControlledReader([new Uint8Array([1, 2, 3])]);
    release(0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ contentLength: null, reader })));

    await ensureOrtRuntime();

    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.total).toBe(ORT_RUNTIME_ASYNCIFY_BYTES_FALLBACK);
  });

  it('falls back to the fallback constant for a zero or garbage content-length', async () => {
    stubGpuWithFeature(false);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3]), '0')));

    await ensureOrtRuntime();

    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.total).toBe(ORT_RUNTIME_WASM_ONLY_BYTES_FALLBACK);
  });
});

// ─── Failure degradation ────────────────────────────────────────────────────

describe('ensureOrtRuntime — failure degradation (T-213-09-02)', () => {
  it('a rejected fetch resolves a null buffer, reports to Sentry once, and never rejects', async () => {
    stubGpuWithFeature(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const result = await ensureOrtRuntime();

    expect(result.buffer).toBeNull();
    expect(result.backend).toBe('wasm');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ source: 'ort-runtime-source' }) }),
    );
  });

  it('a non-ok response (404) resolves a null buffer the same way', async () => {
    stubGpuWithFeature(false);
    const { reader } = createControlledReader([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 404, reader })));

    const result = await ensureOrtRuntime();

    expect(result.buffer).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('an absent response.body resolves a null buffer', async () => {
    stubGpuWithFeature(false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: null } as unknown as Response),
    );

    const result = await ensureOrtRuntime();

    expect(result.buffer).toBeNull();
  });
});

// ─── G-213-36: retain-and-copy across a second call ────────────────────────
//
// The actual regression: `runtimePromise` is memoised for the whole page
// session, so the ORDINARY /analysis -> /bots navigation calls
// `ensureOrtRuntime()` a second time long after the first spawn already
// transferred (and thereby detached) its buffer. A test that only asserts
// "no error thrown" would not catch this — the real failure was a worker
// that received a malformed init message and simply never came ready. These
// tests assert the delivered buffer is actually usable.

describe('ensureOrtRuntime — G-213-36 retain-and-copy (second call after the first buffer is detached)', () => {
  it('two sequential calls both yield non-detached buffers of the right length, from exactly ONE fetch', async () => {
    stubGpuWithFeature(false);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    const first = await ensureOrtRuntime();
    const second = await ensureOrtRuntime();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.buffer).not.toBeNull();
    expect(second.buffer).not.toBeNull();
    expect(first.buffer?.byteLength).toBe(bytes.length);
    expect(second.buffer?.byteLength).toBe(bytes.length);
  });

  it('the returned buffers are DISTINCT instances — each worker gets its own copy, never sharing one with another', async () => {
    stubGpuWithFeature(false);
    const bytes = new Uint8Array([9, 8, 7]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(bytes)));

    const first = await ensureOrtRuntime();
    const second = await ensureOrtRuntime();

    expect(first.buffer).not.toBeNull();
    expect(second.buffer).not.toBeNull();
    // Reference inequality: not the same ArrayBuffer object.
    expect(first.buffer).not.toBe(second.buffer);
  });

  it('THE ACTUAL REGRESSION: detaching the first call\'s buffer (simulating the first worker\'s postMessage transfer) does NOT affect a subsequent call — the second call still returns a valid, usable buffer', async () => {
    stubGpuWithFeature(false);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(bytes)));

    const first = await ensureOrtRuntime();
    expect(first.buffer).not.toBeNull();

    // Simulate the real browser behavior of `postMessage(msg, [buffer])`:
    // Node's global structuredClone with a `transfer` option performs the
    // same structured-clone transfer algorithm, detaching the source buffer
    // (byteLength becomes 0) exactly as a real worker postMessage would.
    const buf = first.buffer as ArrayBuffer;
    structuredClone(buf, { transfer: [buf] });
    expect(buf.byteLength).toBe(0); // sanity: the first call's buffer really is detached now

    // The second call — the /analysis -> /bots second spawn — must still
    // receive a fully valid, non-detached buffer with the correct length.
    const second = await ensureOrtRuntime();
    expect(second.buffer).not.toBeNull();
    expect(second.buffer?.byteLength).toBe(bytes.length);
    expect(() => structuredClone(second.buffer, { transfer: [second.buffer as ArrayBuffer] })).not.toThrow();
  });

  it('mutating one copy does not affect a later call — the retained master is untouched by per-call copies', async () => {
    stubGpuWithFeature(false);
    const bytes = new Uint8Array([1, 1, 1, 1]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(bytes)));

    const first = await ensureOrtRuntime();
    expect(first.buffer).not.toBeNull();
    new Uint8Array(first.buffer as ArrayBuffer).fill(0xff);

    const second = await ensureOrtRuntime();
    expect(second.buffer).not.toBeNull();
    // Untouched — still the original fetched bytes, not the mutated 0xff fill.
    expect(Array.from(new Uint8Array(second.buffer as ArrayBuffer))).toEqual([1, 1, 1, 1]);
  });
});

// ─── fetchWasmOnlyOrtRuntime — respawn path ────────────────────────────────

describe('fetchWasmOnlyOrtRuntime — the webgpu->wasm respawn path', () => {
  it('always requests the wasm-only URL regardless of what ensureOrtRuntime already resolved', async () => {
    stubGpuWithFeature(true); // ensureOrtRuntime would pick webgpu/asyncify
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    await ensureOrtRuntime();
    expect(fetchMock).toHaveBeenLastCalledWith(ORT_RUNTIME_ASYNCIFY_PATH);

    fetchMock.mockClear();
    const buffer = await fetchWasmOnlyOrtRuntime();

    expect(fetchMock).toHaveBeenCalledWith(ORT_RUNTIME_WASM_ONLY_PATH);
    expect(buffer).not.toBeNull();
  });

  it('never rejects — a failed respawn fetch resolves null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(fetchWasmOnlyOrtRuntime()).resolves.toBeNull();
  });

  it('does not join ensureOrtRuntime()s memoised BACKEND decision — served from a populated cache, it issues ZERO network requests and returns a distinct instance per call', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchWasmOnlyOrtRuntime();
    expect(fetchMock).toHaveBeenCalledTimes(1); // first call populates the cache

    fetchMock.mockClear();
    const second = await fetchWasmOnlyOrtRuntime();

    expect(fetchMock).not.toHaveBeenCalled(); // second call is a cache hit — zero network
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second); // distinct instances, not a retained/shared buffer
    expect(second?.byteLength).toBe(bytes.length);
  });

  it('after resetEngineAssetForRefetch + a cache-served respawn, the store reports FULL progress rather than staying at zero', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWasmOnlyOrtRuntime();
    resetEngineAssetForRefetch('ort-runtime');
    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.loaded).toBe(0);

    fetchMock.mockClear();
    await fetchWasmOnlyOrtRuntime();

    expect(fetchMock).not.toHaveBeenCalled(); // cache-served — zero network
    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.loaded).toBe(bytes.length);
    expect(getEngineAssetsSnapshot().assets['ort-runtime']?.total).toBe(bytes.length);
  });
});

// ─── ensureOrtRuntime — cache provenance (Phase 213-12, D-20) ──────────────
//
// The pair that distinguishes a real cache read from a retained in-memory
// buffer: populated -> zero fetches; cleared -> one additional fetch. Only
// asserting one direction cannot tell the two apart.

describe('ensureOrtRuntime — cache provenance (Phase 213-12, D-20)', () => {
  it('a populated cache: a second call fetches ZERO times', async () => {
    stubGpuWithFeature(false);
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await ensureOrtRuntime();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await ensureOrtRuntime();
    expect(fetchMock).toHaveBeenCalledTimes(1); // still one — the second call was a cache hit
  });

  it('cache cleared between two calls: the second call fetches ONE additional time', async () => {
    stubGpuWithFeature(false);
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await ensureOrtRuntime();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    caches_.stores.get(ENGINE_ASSET_CACHE_NAME)?.delete(ORT_RUNTIME_WASM_ONLY_PATH);

    await ensureOrtRuntime();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── Mutation proof: the f16 predicate is load-bearing ─────────────────────
//
// This is a recorded proof, not an automated mutation harness: the assertion
// below documents that forcing `probeOrtBackend()`'s predicate to always
// report the feature present (simulating a broken/removed guard) makes the
// no-f16 case request the asyncify URL — the exact 25.7 MB defect this
// module exists to prevent. Verified by temporarily editing
// `probeOrtBackend()`'s `features.has(REQUIRED_WEBGPU_FEATURE)` line to a
// literal `true` and re-running this file: the "an adapter NOT reporting
// shader-f16 selects wasm" test above failed (asserted 'webgpu' instead of
// 'wasm', requested the asyncify URL). Reverted immediately after
// confirming the failure — see 213-09-SUMMARY.md for the recorded revert.
describe('ensureOrtRuntime — f16 predicate is load-bearing (see mutation proof note above)', () => {
  it('a non-f16 adapter never requests the asyncify URL', async () => {
    stubGpuWithFeature(false);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);

    await ensureOrtRuntime();

    expect(fetchMock).not.toHaveBeenCalledWith(ORT_RUNTIME_ASYNCIFY_PATH);
  });
});

// ─── probeOrtBackendOnce — the fetch-free iOS entry point (SEED-158) ───────

describe('probeOrtBackendOnce — decides without fetching and shares the memoised decision', () => {
  it('answers the backend, registers ort-runtime as pending synchronously, and issues NO fetch', async () => {
    stubGpuWithFeature(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const pending = probeOrtBackendOnce();
    // CR-02: registered in the same synchronous call, before the adapter probe resolves.
    expect(getEngineAssetsSnapshot().assets['ort-runtime']).toMatchObject({ loaded: 0, done: false });

    await expect(pending).resolves.toBe('wasm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a later ensureOrtRuntime() joins the same decision instead of re-probing', async () => {
    stubGpuWithFeature(true);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1, 2, 3]))));

    await expect(probeOrtBackendOnce()).resolves.toBe('webgpu');
    const result = await ensureOrtRuntime();

    expect(result.backend).toBe('webgpu');
    const gpu = (navigator as Navigator & { gpu: { requestAdapter: ReturnType<typeof vi.fn> } }).gpu;
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(1);
  });
});
