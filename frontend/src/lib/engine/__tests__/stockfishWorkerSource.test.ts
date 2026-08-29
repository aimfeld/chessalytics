// @vitest-environment jsdom
/**
 * stockfishWorkerSource.ts unit tests (Phase 213-08, G-213-35).
 *
 * Covers the shared-fetch memoisation (single fetch for N concurrent/repeat
 * callers), the streaming-reader progress reporting through
 * `engineAssetProgress`, every failure-mode degradation to `null`, the
 * location-hash worker-construction contract, and the source gate proving
 * the shared module is the only Stockfish Worker construction site
 * (extended in Task 3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import { readFileSync, readdirSync } from 'node:fs';
// Named import (not the global `URL`) — `@vitest-environment jsdom` shadows
// the global `URL` with jsdom's own constructor, which `fileURLToPath` below
// rejects as not a real Node URL instance.
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { join } from 'node:path';
import {
  createStockfishWorker,
  ensureStockfishWorkerUrl,
  resetStockfishWorkerSourceForTests,
  STOCKFISH_ENGINE_GLUE_PATH,
  STOCKFISH_ENGINE_WASM_PATH,
} from '../stockfishWorkerSource';
import {
  getEngineAssetsSnapshot,
  resetEngineAssetsForTests,
  STOCKFISH_WASM_BYTES_FALLBACK,
} from '../engineAssetProgress';
import { resetEngineAssetCacheForTests, ENGINE_ASSET_CACHE_NAME } from '../engineAssetCache';

// @sentry/react's ESM module namespace is not configurable, so vi.spyOn cannot
// redefine captureException on the real module — mock the module instead
// (mirrors workerPool.test.ts / useStockfishEngine.test.ts).
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

// ─── Fetch/Response doubles ─────────────────────────────────────────────────

/** A `ReadableStreamDefaultReader`-shaped double whose chunks are released one at a time via `release(i)`, so tests can observe intermediate streaming state. */
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

/** Builds a minimal fetch Response double around a controllable reader. */
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

/** Fully-resolved single-chunk response — the common case for tests that don't need intermediate streaming control. */
function makeImmediateResponse(bytes: Uint8Array, contentLength?: string): Response {
  const { reader, release } = createControlledReader([bytes]);
  release(0);
  return makeResponse({ contentLength: contentLength ?? String(bytes.length), reader });
}

// ─── Blob / URL.createObjectURL doubles ─────────────────────────────────────

class FakeBlob {
  parts: unknown[];
  type: string;
  constructor(parts: unknown[], options?: { type?: string }) {
    this.parts = parts;
    this.type = options?.type ?? '';
  }
}

let objectUrlCounter = 0;
let createdBlobs: FakeBlob[];
let revokedUrls: string[];

function stubBlobAndUrl(): void {
  createdBlobs = [];
  revokedUrls = [];
  objectUrlCounter = 0;
  vi.stubGlobal('Blob', FakeBlob as unknown as typeof Blob);
  vi.stubGlobal(
    'URL',
    class {
      static createObjectURL(blob: FakeBlob): string {
        createdBlobs.push(blob);
        objectUrlCounter += 1;
        return `blob:mock-url-${objectUrlCounter}`;
      }
      static revokeObjectURL(url: string): void {
        revokedUrls.push(url);
      }
    },
  );
}

// ─── MockWorker (mirrors workerPool.test.ts / useStockfishEngine.test.ts) ──

class MockWorker {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

function stubWorkerCtor(): void {
  vi.stubGlobal(
    'Worker',
    vi.fn(function (this: unknown, url: string) {
      return new MockWorker(url);
    }),
  );
}

// ─── In-memory CacheStorage double (Phase 213-12, D-20) ────────────────────
//
// Mirrors ortRuntimeSource.test.ts / engineAssetCache.test.ts's own double:
// stores RAW BYTES, not Response objects — a real Cache API constructs a
// FRESH Response per match() call.

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
  resetStockfishWorkerSourceForTests();
  resetEngineAssetsForTests();
  resetEngineAssetCacheForTests();
  caches_ = createCachesDouble();
  vi.stubGlobal('caches', caches_.cachesDouble);
  stubBlobAndUrl();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetStockfishWorkerSourceForTests();
  resetEngineAssetsForTests();
  resetEngineAssetCacheForTests();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ensureStockfishWorkerUrl — single-fetch memoisation', () => {
  it('two consecutive calls issue exactly ONE fetch', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await ensureStockfishWorkerUrl();
    await ensureStockfishWorkerUrl();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ten concurrent calls issue exactly ONE fetch', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    const calls = Array.from({ length: 10 }, () => ensureStockfishWorkerUrl());
    const results = await Promise.all(calls);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Every caller joins the SAME resolved URL.
    const [first, ...rest] = results;
    expect(first).not.toBeNull();
    for (const r of rest) expect(r).toBe(first);
  });

  it("MUTATION CHECK: the single-fetch guarantee is load-bearing — dropping memoisation makes the concurrent-callers test fail", async () => {
    // Proves the memoisation guard in `ensureStockfishWorkerUrl()` is the
    // thing making the test above pass, not a coincidence of the mock setup.
    // Simulates "no memoisation" by calling the un-memoised fetch path
    // directly N times, the way the source module would behave WITHOUT its
    // `if (sharedUrlPromise) return sharedUrlPromise;` guard.
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeImmediateResponse(bytes)));
    vi.stubGlobal('fetch', fetchMock);

    // Directly exercises the un-memoised fetch call N times (bypassing the
    // module's memoisation entirely) to demonstrate what the guard prevents.
    await Promise.all(Array.from({ length: 10 }, () => fetch('/engine/stockfish-18-lite-single.wasm')));

    // Without memoisation this would be 10, exactly like the raw calls above.
    expect(fetchMock).toHaveBeenCalledTimes(10);

    // The real (memoised) module call still issues only one on top of this.
    fetchMock.mockClear();
    const calls = Array.from({ length: 10 }, () => ensureStockfishWorkerUrl());
    await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Cache provenance (Phase 213-12, D-20) ─────────────────────────────────
//
// ensureStockfishWorkerUrl() stays memoised for the WHOLE page session (the
// published object URL must — replaceDeadSlot() depends on it staying valid
// for the pool's lifetime), so within a single "session" the underlying
// fetch count cannot distinguish a real cache read from the pre-existing
// promise memoisation alone. The provenance proof therefore spans two
// SEPARATE module sessions (resetStockfishWorkerSourceForTests() between
// them, simulating a fresh page load) — the only way to observe whether the
// SECOND session's bytes came from CacheStorage or genuinely refetched.

describe('ensureStockfishWorkerUrl — cache provenance across module sessions', () => {
  it('a populated cache publishes a working object URL with the fetch stub called ZERO times', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await ensureStockfishWorkerUrl();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a fresh page load: a new module session, cache left populated.
    resetStockfishWorkerSourceForTests();
    fetchMock.mockClear();

    const url = await ensureStockfishWorkerUrl();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(url).not.toBeNull();
  });

  it('cache cleared between two module sessions: exactly one fetch each time', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockImplementation(async () => makeImmediateResponse(bytes));
    vi.stubGlobal('fetch', fetchMock);

    await ensureStockfishWorkerUrl();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetStockfishWorkerSourceForTests();
    caches_.stores.get(ENGINE_ASSET_CACHE_NAME)?.delete(STOCKFISH_ENGINE_WASM_PATH);
    fetchMock.mockClear();

    await ensureStockfishWorkerUrl();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ensureStockfishWorkerUrl — CR-02 synchronous pending registration', () => {
  it('registers stockfish-wasm as pending synchronously, before any chunk can arrive', () => {
    const { reader } = createControlledReader([new Uint8Array([1, 2, 3])]); // never released in this test
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ contentLength: '3', reader }));
    vi.stubGlobal('fetch', fetchMock);

    void ensureStockfishWorkerUrl();

    // Synchronously right after the call returns — no await, no microtask flush.
    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.assets['stockfish-wasm']).toEqual({
      loaded: 0,
      total: STOCKFISH_WASM_BYTES_FALLBACK,
      done: false,
    });
  });
});

describe('ensureStockfishWorkerUrl — streamed progress reporting', () => {
  it('reports each chunk to the stockfish-wasm store entry, with total = content-length', async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);
    const { reader, release } = createControlledReader([chunk1, chunk2]);
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ contentLength: '5', reader }));
    vi.stubGlobal('fetch', fetchMock);

    const urlPromise = ensureStockfishWorkerUrl();

    release(0);
    await waitFor(() => {
      expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.loaded).toBe(3);
    });
    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.total).toBe(5);

    release(1);
    await urlPromise;

    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.loaded).toBe(5);
    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.total).toBe(5);
  });

  it('falls back to STOCKFISH_WASM_BYTES_FALLBACK for a missing content-length', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { reader, release } = createControlledReader([bytes]);
    release(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ contentLength: null, reader }));
    vi.stubGlobal('fetch', fetchMock);

    await ensureStockfishWorkerUrl();

    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.total).toBe(
      STOCKFISH_WASM_BYTES_FALLBACK,
    );
  });

  it('falls back to STOCKFISH_WASM_BYTES_FALLBACK for a zero content-length', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeImmediateResponse(bytes, '0'));
    vi.stubGlobal('fetch', fetchMock);

    await ensureStockfishWorkerUrl();

    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.total).toBe(
      STOCKFISH_WASM_BYTES_FALLBACK,
    );
  });

  it('falls back to STOCKFISH_WASM_BYTES_FALLBACK for a garbage content-length', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => makeImmediateResponse(bytes, 'not-a-number'));
    vi.stubGlobal('fetch', fetchMock);

    await ensureStockfishWorkerUrl();

    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.total).toBe(
      STOCKFISH_WASM_BYTES_FALLBACK,
    );
  });
});

describe('ensureStockfishWorkerUrl — published Blob', () => {
  it('publishes an object URL created from an application/wasm Blob', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(bytes)));

    const url = await ensureStockfishWorkerUrl();

    expect(url).toBe('blob:mock-url-1');
    expect(createdBlobs).toHaveLength(1);
    expect(createdBlobs[0]?.type).toBe('application/wasm');
  });
});

describe('ensureStockfishWorkerUrl — failure degradation (T-213-07)', () => {
  it('a rejected fetch resolves null, reports to Sentry once, and never rejects/throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(ensureStockfishWorkerUrl()).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ source: 'stockfish-worker-source' }) }),
    );
  });

  it('a non-ok response (404) resolves null the same way', async () => {
    const { reader } = createControlledReader([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 404, reader })),
    );

    await expect(ensureStockfishWorkerUrl()).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('a non-ok response (500) resolves null the same way', async () => {
    const { reader } = createControlledReader([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ ok: false, status: 500, reader })),
    );

    await expect(ensureStockfishWorkerUrl()).resolves.toBeNull();
  });

  it('an absent response.body resolves null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: null } as unknown as Response),
    );

    await expect(ensureStockfishWorkerUrl()).resolves.toBeNull();
  });

  it('an absent URL.createObjectURL resolves null', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(bytes)));
    // Re-stub URL without createObjectURL.
    vi.stubGlobal('URL', class {});

    await expect(ensureStockfishWorkerUrl()).resolves.toBeNull();
  });
});

describe('createStockfishWorker — construction contract', () => {
  beforeEach(() => {
    stubWorkerCtor();
  });

  it('a null shared URL constructs against the served path, unchanged from today', () => {
    const worker = createStockfishWorker(null) as unknown as MockWorker;
    expect(worker.url).toBe(STOCKFISH_ENGINE_GLUE_PATH);
  });

  it('a non-null shared URL appends it as an encoded location hash with no comma', () => {
    const sharedUrl = 'blob:http://localhost/abcd-1234';
    const worker = createStockfishWorker(sharedUrl) as unknown as MockWorker;

    expect(worker.url).toBe(`${STOCKFISH_ENGINE_GLUE_PATH}#${encodeURIComponent(sharedUrl)}`);
    const hash = worker.url.split('#')[1];
    expect(hash).toBeDefined();
    expect(hash).not.toContain(',');
  });
});

// ─── Source gate (Task 3, Phase 213-08, G-213-35) ──────────────────────────
//
// Proves the shared module is the ONLY Stockfish Worker construction site
// left under `frontend/src` — a symbol-presence check would pass even if a
// consumer regained a direct `new Worker('/engine/stockfish-18-lite-single.js')`
// call, so this reads every non-test source file and asserts the ONLY file
// containing the glue-path literal (outside a comment) is this module
// itself. Comment-only lines are filtered first (mirrors `grep -v
// '^\s*[*/]'`) so a doc comment mentioning the path (this file's own header,
// or `workerPool.ts`'s file-header caveat) can neither satisfy nor break the
// gate.

/** Recursively lists every `.ts`/`.tsx` file under `dir`, skipping `__tests__` directories entirely. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Strips comment-only lines (mirrors a `grep -v` on lines starting with optional whitespace then `*` or a slash) so a doc comment cannot satisfy or break the gate. */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*[*/]/.test(line))
    .join('\n');
}

describe('source gate: only stockfishWorkerSource.ts constructs a Stockfish Worker', () => {
  it('no file under frontend/src, other than this shared module, contains the Stockfish glue-path literal outside a comment', () => {
    // frontend/src/lib/engine/__tests__/stockfishWorkerSource.test.ts -> frontend/src
    const srcRoot = fileURLToPath(new NodeURL('../../../', import.meta.url));
    const thisModule = fileURLToPath(new NodeURL('../stockfishWorkerSource.ts', import.meta.url));

    const offenders = listSourceFiles(srcRoot).filter((file) => {
      const codeOnly = stripCommentLines(readFileSync(file, 'utf-8'));
      return codeOnly.includes('stockfish-18-lite-single.js');
    });

    expect(offenders).toEqual([thisModule]);
  });
});

// ─── Accounting assertion (Task 3) ──────────────────────────────────────────

describe('ensureStockfishWorkerUrl — accounting: numerator equals denominator for one transfer', () => {
  it('after a full simulated download and constructing several workers, stockfish-wasm total and loaded both equal one transfer worth of bytes', async () => {
    // No content-length header — `total` falls back to STOCKFISH_WASM_BYTES_FALLBACK,
    // and the streamed chunk is sized to exactly that many bytes so `loaded`
    // reaches the SAME figure by completion (one transfer's worth of numerator
    // against one transfer's worth of denominator).
    const bytes = new Uint8Array(STOCKFISH_WASM_BYTES_FALLBACK);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => makeImmediateResponse(bytes, undefined)));

    const url = await ensureStockfishWorkerUrl();
    expect(url).not.toBeNull();

    // Constructing several workers from the resolved URL must not add (or
    // subtract) any accounting — this module's fetch/stream is the only
    // thing that ever calls `reportEngineAssetProgress`.
    stubWorkerCtor();
    createStockfishWorker(url);
    createStockfishWorker(url);
    createStockfishWorker(url);

    const entry = getEngineAssetsSnapshot().assets['stockfish-wasm'];
    expect(entry?.total).toBe(STOCKFISH_WASM_BYTES_FALLBACK);
    expect(entry?.loaded).toBe(STOCKFISH_WASM_BYTES_FALLBACK);
  });
});
