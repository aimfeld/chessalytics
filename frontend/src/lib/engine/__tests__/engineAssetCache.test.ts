// @vitest-environment jsdom
/**
 * engineAssetCache.ts unit tests (Phase 213-12, D-20, closing G-213-37).
 *
 * jsdom has no real CacheStorage, so `caches` is stubbed with an in-memory
 * `Map`-backed double supporting `open`/`keys`/`delete`, and a per-cache
 * object supporting `match`/`put`. Covers cache-hit zero-fetch, the
 * populated/cleared pair that distinguishes a real cache read from a
 * retained in-memory buffer, concurrent-caller distinct-instance safety, the
 * prefix-scoped stale sweep (never touching Workbox caches), zero-length
 * treated as a miss, non-ok responses never cached, `caches` absence
 * degrading to a plain fetch, and the quota-failure skip-further-writes
 * path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import {
  getEngineAsset,
  resetEngineAssetCacheForTests,
  ENGINE_ASSET_CACHE_NAME,
  ENGINE_ASSET_CACHE_NAME_PREFIX,
  ENGINE_ASSET_VERSION_QUERY,
  versionedEngineAssetUrl,
} from '../engineAssetCache';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const TEST_ASSET_ID = 'maia-model' as const;
const TEST_URL = '/maia/maia3_simplified.onnx';
const FALLBACK_BYTES = 1000;

// ─── In-memory CacheStorage double ─────────────────────────────────────────

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
  putSpy: ReturnType<typeof vi.fn>;
} {
  // Stores RAW BYTES, not Response objects — a real Cache API's match()
  // constructs a FRESH Response wrapping the stored bytes on every call, so a
  // caller can consume .arrayBuffer() as many times (across as many match()
  // calls) as it likes. Storing a Response object directly would make the
  // SECOND match() + .arrayBuffer() on the same entry throw "body already
  // read" — a bug this double must not reproduce.
  const stores = new Map<string, Map<string, Uint8Array>>();
  const putSpy = vi.fn();

  function makeCacheHandle(name: string): FakeCacheHandle {
    return {
      match: async (url: string) => {
        const bytes = stores.get(name)?.get(url);
        return bytes ? new Response(bytes) : undefined;
      },
      put: async (url: string, response: Response) => {
        putSpy(name, url);
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

  return { cachesDouble, stores, putSpy };
}

/** Directly seeds a cache entry, bypassing `getEngineAsset` entirely — simulates "already downloaded in a prior session". */
function seedCache(stores: Map<string, Map<string, Uint8Array>>, name: string, url: string, bytes: Uint8Array): void {
  const store = stores.get(name) ?? new Map<string, Uint8Array>();
  store.set(url, bytes);
  stores.set(name, store);
}

// ─── fetch doubles (mirrors ortRuntimeSource.test.ts / stockfishWorkerSource.test.ts) ──

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
  return { reader, release: (i: number) => gates[i]?.resolve() };
}

function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  contentLength?: string | null;
  contentEncoding?: string;
  reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
}): Response {
  const { ok = true, status = 200, contentLength = null, contentEncoding, reader } = opts;
  const headers = new Headers();
  if (contentLength !== null) headers.set('content-length', contentLength);
  if (contentEncoding) headers.set('content-encoding', contentEncoding);
  return { ok, status, headers, body: { getReader: () => reader } } as unknown as Response;
}

function makeImmediateResponse(bytes: Uint8Array, contentLength?: string): Response {
  const { reader, release } = createControlledReader([bytes]);
  release(0);
  return makeResponse({ contentLength: contentLength ?? String(bytes.length), reader });
}

// ─── Setup ───────────────────────────────────────────────────────────────────

let caches_: ReturnType<typeof createCachesDouble>;

beforeEach(() => {
  resetEngineAssetCacheForTests();
  caches_ = createCachesDouble();
  vi.stubGlobal('caches', caches_.cachesDouble);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetEngineAssetCacheForTests();
});

// ─── Cache-hit zero-fetch ───────────────────────────────────────────────────

describe('getEngineAsset — cache hit', () => {
  it('a populated cache resolves full-length bytes with ZERO fetches', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    seedCache(caches_.stores, ENGINE_ASSET_CACHE_NAME, TEST_URL, bytes);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const onProgress = vi.fn();
    const result = await getEngineAsset(TEST_ASSET_ID, TEST_URL, onProgress, FALLBACK_BYTES);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.byteLength).toBe(bytes.length);
    expect(onProgress).toHaveBeenCalledWith(bytes.length, bytes.length);
  });
});

// ─── The pair that distinguishes real cache reads from a retained buffer ──

describe('getEngineAsset — populated-vs-cleared pair (real cache read, not a retained buffer)', () => {
  it('after one completed call, clearing the cache and calling again produces exactly ONE additional fetch', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    // A fresh response per call — a real fetch never hands back an already
    // consumed body, and the CR-01 truncation guard rightly rejects one.
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Clear the cache entry directly (simulates a fresh page session / evicted cache).
    caches_.stores.get(ENGINE_ASSET_CACHE_NAME)?.delete(TEST_URL);

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaving the cache populated between two calls produces ZERO additional fetches', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Concurrent callers: one fetch, distinct instances ─────────────────────

describe('getEngineAsset — concurrent callers', () => {
  it('two concurrent calls produce exactly one fetch and two DISTINCT ArrayBuffer instances; detaching one leaves the other full-length', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES),
      getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);

    structuredClone(first, { transfer: [first] });
    expect(first.byteLength).toBe(0);
    expect(second.byteLength).toBe(bytes.length);
  });

  it('ten concurrent calls produce exactly one fetch', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all(
      Array.from({ length: 10 }, () => getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES)),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Single-flight entry is dropped once it settles ────────────────────────

describe('getEngineAsset — single-flight entry does not survive past the fetch window', () => {
  it('after a completed call settles, clearing the cache and calling again refetches (nothing retained in module scope)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    // Fresh response per call — see the populated-vs-cleared test above.
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    caches_.stores.get(ENGINE_ASSET_CACHE_NAME)?.delete(TEST_URL);

    const fetchMock2Calls = fetchMock.mock.calls.length;
    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(fetchMock.mock.calls.length).toBe(fetchMock2Calls + 1);
  });
});

// ─── Failures never write to the cache, and propagate ──────────────────────

describe('getEngineAsset — failure handling', () => {
  it('a non-ok response writes NOTHING to the cache and the call rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 404, reader: createControlledReader([]).reader })));

    await expect(getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES)).rejects.toThrow();
    expect(caches_.stores.get(ENGINE_ASSET_CACHE_NAME)?.has(TEST_URL)).toBeFalsy();
  });

  it('an absent response.body writes nothing and rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: null } as unknown as Response),
    );

    await expect(getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES)).rejects.toThrow();
    expect(caches_.stores.get(ENGINE_ASSET_CACHE_NAME)?.has(TEST_URL)).toBeFalsy();
  });

  it('a rejected fetch propagates the failure to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES)).rejects.toThrow('network down');
  });
});

// ─── Zero-length cached entry is treated as a miss ─────────────────────────

describe('getEngineAsset — zero-length cached entry', () => {
  it('a zero-length cached entry is refetched rather than returned', async () => {
    seedCache(caches_.stores, ENGINE_ASSET_CACHE_NAME, TEST_URL, new Uint8Array(0));
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.byteLength).toBe(bytes.length);
  });
});

// ─── caches absent: plain fetch, unchanged progress ────────────────────────

describe('getEngineAsset — caches absent', () => {
  it('with caches stubbed to undefined, getEngineAsset still resolves via a plain fetch and reports progress', async () => {
    vi.stubGlobal('caches', undefined);
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);
    const onProgress = vi.fn();

    const result = await getEngineAsset(TEST_ASSET_ID, TEST_URL, onProgress, FALLBACK_BYTES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.byteLength).toBe(bytes.length);
    expect(onProgress).toHaveBeenCalledWith(bytes.length, bytes.length);
  });
});

// ─── Streamed progress reporting ───────────────────────────────────────────

describe('getEngineAsset — streamed progress reporting on a miss', () => {
  it('reports each chunk, with total = content-length', async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const { reader, release } = createControlledReader([chunk1, chunk2]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ contentLength: '5', reader })));
    const onProgress = vi.fn();

    const resultPromise = getEngineAsset(TEST_ASSET_ID, TEST_URL, onProgress, FALLBACK_BYTES);

    release(0);
    await waitFor(() => {
      expect(onProgress).toHaveBeenCalledWith(3, 5);
    });
    release(1);
    const result = await resultPromise;

    expect(onProgress).toHaveBeenCalledWith(5, 5);
    expect(result.byteLength).toBe(5);
  });

  it('falls back to fallbackBytes for a missing content-length', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { reader, release } = createControlledReader([bytes]);
    release(0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ contentLength: null, reader })));
    const onProgress = vi.fn();

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, onProgress, FALLBACK_BYTES);

    expect(onProgress).toHaveBeenLastCalledWith(3, FALLBACK_BYTES);
  });
});

// ─── CR-01: truncated / unverifiable bodies are never cached ───────────────

describe('getEngineAsset — truncation guard (CR-01)', () => {
  it('a stream that ends short of a trustworthy content-length rejects and writes NOTHING to the cache', async () => {
    // Clean-EOF truncation: the reader reports done after 3 of 5 declared
    // bytes without ever rejecting — the shape CR-01 identified as being
    // persisted and served back as complete indefinitely.
    const { reader, release } = createControlledReader([new Uint8Array([1, 2, 3])]);
    release(0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({ contentLength: '5', reader })));

    await expect(getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES)).rejects.toThrow(/truncated/i);
    expect(caches_.putSpy).not.toHaveBeenCalled();
    expect(caches_.stores.get(ENGINE_ASSET_CACHE_NAME)?.get(TEST_URL)).toBeUndefined();
  });

  it('a missing content-length resolves the bytes but does NOT cache them — the next call fetches again', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => {
      const { reader, release } = createControlledReader([bytes]);
      release(0);
      return makeResponse({ contentLength: null, reader });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(new Uint8Array(first)).toEqual(bytes);
    expect(caches_.putSpy).not.toHaveBeenCalled();

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a content-encoded response (content-length is the WIRE size, not decoded bytes) resolves without throwing and without caching', async () => {
    // 5 decoded bytes behind a declared wire size of 3 — comparing the two
    // would be a false truncation, so the length is untrustworthy: return
    // the bytes, skip the cache write.
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { reader, release } = createControlledReader([bytes]);
    release(0);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ contentLength: '3', contentEncoding: 'gzip', reader })),
    );

    const result = await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);

    expect(new Uint8Array(result)).toEqual(bytes);
    expect(caches_.putSpy).not.toHaveBeenCalled();
  });
});

// ─── Quota failure: bytes still resolve, further writes skipped ───────────

describe('getEngineAsset — cache.put quota failure', () => {
  it('a cache.put that rejects still resolves the bytes, reports once to Sentry, and skips further writes this session', async () => {
    const putError = new Error('QuotaExceededError');
    const failingCache: FakeCacheHandle = {
      match: async () => undefined,
      put: async () => {
        throw putError;
      },
    };
    vi.stubGlobal('caches', {
      open: async () => failingCache,
      keys: async () => [],
      delete: async () => true,
    });

    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);
    expect(result.byteLength).toBe(bytes.length);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ source: 'engine-asset-cache' }) }),
    );

    // A second call (different id, forces a fresh streamAndCache call since
    // the first entry already settled and the cache never actually stored
    // anything) must not attempt a put again — the module-level skip flag
    // persists across assets for the rest of the page session.
    const putSpy = vi.spyOn(failingCache, 'put');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([4, 5]))));
    await getEngineAsset('ort-runtime', '/other-url', vi.fn(), FALLBACK_BYTES);
    expect(putSpy).not.toHaveBeenCalled();
  });
});

// ─── Prefix-scoped stale sweep ──────────────────────────────────────────────

describe('getEngineAsset — stale-cache sweep on open', () => {
  it('deletes an older-versioned engine-asset cache but leaves Workbox caches untouched', async () => {
    caches_.stores.set(`${ENGINE_ASSET_CACHE_NAME_PREFIX}v0`, new Map());
    caches_.stores.set('workbox-precache-v2-x', new Map());
    caches_.stores.set('html-shell', new Map());
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);

    await getEngineAsset(TEST_ASSET_ID, TEST_URL, vi.fn(), FALLBACK_BYTES);

    expect(caches_.stores.has(`${ENGINE_ASSET_CACHE_NAME_PREFIX}v0`)).toBe(false);
    expect(caches_.stores.has('workbox-precache-v2-x')).toBe(true);
    expect(caches_.stores.has('html-shell')).toBe(true);
    expect(caches_.stores.has(ENGINE_ASSET_CACHE_NAME)).toBe(true);
  });
});

// ─── One-knob invariant (quick 260905-rhc) ─────────────────────────────────
//
// `ENGINE_ASSET_CACHE_VERSION` must be the SOLE source feeding both the
// CacheStorage name and the URL query suffix — a second independent version
// source is exactly the failure mode this task exists to remove (D-01).
// Both assertions below use a regex, never a hardcoded version number, so a
// future bump does not require editing this test.

describe('versionedEngineAssetUrl / ENGINE_ASSET_VERSION_QUERY — one-knob invariant', () => {
  it('versionedEngineAssetUrl appends the path with a ?v=<digits> suffix', () => {
    const url = versionedEngineAssetUrl('/maia/some-arbitrary-path.mjs');
    expect(url).toMatch(/^\/maia\/some-arbitrary-path\.mjs\?v=\d+$/);
  });

  it('ENGINE_ASSET_VERSION_QUERY and the version embedded in ENGINE_ASSET_CACHE_NAME are the SAME digits', () => {
    const queryDigits = ENGINE_ASSET_VERSION_QUERY.match(/^\?v=(\d+)$/)?.[1];
    const cacheNameDigits = ENGINE_ASSET_CACHE_NAME.match(/v(\d+)$/)?.[1];

    expect(queryDigits).toBeDefined();
    expect(cacheNameDigits).toBeDefined();
    expect(queryDigits).toBe(cacheNameDigits);
  });
});
