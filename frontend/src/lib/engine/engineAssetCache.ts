/**
 * engineAssetCache — the single byte-ownership layer for all three engine
 * assets (Maia model, ORT runtime, Stockfish wasm) backed by the browser's
 * Cache API (D-20, closing G-213-37).
 *
 * Bug fix: the 45.7 MB Maia model was fetched ONLY inside `maia-worker.js`
 * (`fetch(MODEL_PATH)`) — a worker deliberately terminated at zero leases
 * every time `BotsGame` unmounts (FLAWCHESS-92's mobile-OOM policy), i.e. on
 * EVERY new game or rematch, by design. The only thing that had ever hidden
 * the resulting per-game re-download was the browser's HTTP cache, and
 * DevTools "Disable cache" — exactly how this phase is verified — removes
 * it. The ORT runtime (213-11) and the Stockfish wasm (213-08) each got
 * their own in-memory patch for their own path, but neither reaches INSIDE
 * the worker where the model lives, so the largest of the three assets had
 * no cache at all. That hole is G-213-37.
 *
 * CacheStorage resolves the contradiction between "download once, zero
 * refetches across surfaces" and "free the worker's heap at zero leases": it
 * is disk-backed (no main-thread RAM retention, no OOM regression), it is
 * reachable from INSIDE `DedicatedWorkerGlobalScope` (the worker can read it
 * directly — see `maia-worker.js`'s own small mirror of this module, which
 * cannot `import` a TS module — file header there), and it is NOT bypassed
 * by DevTools "Disable cache", so the zero-refetch criterion becomes
 * honestly measurable for the first time.
 *
 * `public/` engine assets are not content-hashed, so THIS MODULE'S cache-name
 * version constant is the only invalidation path — bump
 * `ENGINE_ASSET_CACHE_VERSION` in the same commit as replacing any of the
 * three asset files (see `public/maia/README.md`'s matching note).
 */

import * as Sentry from '@sentry/react';
import type { EngineAssetId } from './engineAssetProgress';

// ─── Named constants (CLAUDE.md no-magic-numbers) ──────────────────────────

/**
 * Bump in the SAME commit as replacing any of the three engine asset files —
 * `public/` assets are not content-hashed, so this version number IS the
 * invalidation path (the next `openEngineAssetCache()` sweeps every
 * differently-versioned engine-asset cache away). Deliberately NOT exported
 * (knip): nothing outside this module needs the raw number, only the derived
 * name below.
 *
 * Bumped 1 -> 2 (Phase 217-02, 2026-09-05): the six vendored onnxruntime-web
 * runtime files under `public/maia/` were replaced at 1.29.0 (different
 * bytes, same filenames), so every returning browser must discard its
 * cached 1.27.0-era bytes rather than keep serving them indefinitely.
 *
 * Bumped 2 -> 3 (quick 260905-rhc, 2026-09-05): the URLs built from this
 * constant now carry a `?v=<n>` query (see `ENGINE_ASSET_VERSION_QUERY` /
 * `versionedEngineAssetUrl` below), so every existing `...-v2` CacheStorage
 * entry keys on a URL nothing will ever request again. Bumping makes the
 * next open/sweep delete those orphans rather than retain ~67 MB
 * unreachable forever.
 *
 * Bumped 3 -> 4 (Phase 219-01, 2026-09-06): the six vendored onnxruntime-web
 * runtime files under `public/maia/` were re-vendored back to 1.27.0
 * (different bytes, same filenames — 1.29.0's wasm build measured 1.5-2.3x
 * slower single-threaded, see `219-MEASUREMENTS.md`), so every returning
 * browser must discard its cached 1.29.0-era bytes rather than keep serving
 * the slower runtime indefinitely.
 *
 * Bumped 4 -> 5 (quick 260906-p54, 2026-09-06): both vendored ORT glue
 * loaders (`ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.asyncify.mjs`)
 * now carry a 1 GB wasm memory reservation cap (different bytes, same
 * filenames) fixing FLAWCHESS-9V, an iOS Safari out-of-memory crash caused by
 * WebKit's three-large-reservation-per-page budget. Every returning browser
 * must discard the cached 4 GB-reserving loaders. The `?v=<n>` query this
 * constant feeds also invalidates the Cloudflare edge, so no manual CF purge
 * is needed.
 */
const ENGINE_ASSET_CACHE_VERSION = 5;

/**
 * The shared `?v=<n>` query suffix, derived from `ENGINE_ASSET_CACHE_VERSION`
 * — appended to every runtime-fetched `/maia/*` and `/engine/*` URL via
 * `versionedEngineAssetUrl()` below. `public/` engine assets are not
 * content-hashed, and a CDN (Cloudflare) and the browser's HTTP cache both
 * key a cached response on the FULL URL including its query string, so this
 * suffix is what makes a stale edge or HTTP-cache entry structurally
 * unservable the moment the version bumps: after a bump, every URL the app
 * asks for is one no cache layer has ever seen. One bump of
 * `ENGINE_ASSET_CACHE_VERSION` therefore invalidates all three cache layers
 * at once (CacheStorage name, browser HTTP cache, CDN edge) — see
 * `public/maia/README.md`'s matching note. Sent to `maia-worker.js` in the
 * init message (`assetVersionQuery`) since that classic Worker script cannot
 * import this TS module.
 */
export const ENGINE_ASSET_VERSION_QUERY = `?v=${ENGINE_ASSET_CACHE_VERSION}`;

/**
 * Appends the shared version query to `path`. The single call site every
 * versioned engine-asset URL constant must be built through — never
 * construct a `?v=` suffix by hand, and never export the raw
 * `ENGINE_ASSET_CACHE_VERSION` number for a call site to concatenate itself
 * (that would be a second, driftable source of the same suffix).
 */
export function versionedEngineAssetUrl(path: string): string {
  return `${path}${ENGINE_ASSET_VERSION_QUERY}`;
}

/**
 * The stale-cache sweep filters on this prefix — never anything broader.
 * The PWA's offline shell lives in Workbox caches (`html-shell`,
 * `workbox-precache-*`) in the SAME CacheStorage; a broader filter would
 * delete those too.
 */
export const ENGINE_ASSET_CACHE_NAME_PREFIX = 'flawchess-engine-assets-';

/**
 * The current versioned cache name — also the value sent to
 * `maia-worker.js` in the init message (`assetCacheName`), so the worker
 * reaches the SAME cache by name rather than duplicating this literal.
 */
export const ENGINE_ASSET_CACHE_NAME = `${ENGINE_ASSET_CACHE_NAME_PREFIX}v${ENGINE_ASSET_CACHE_VERSION}`;

// ─── Module-level singleton state ──────────────────────────────────────────

/**
 * Memoised so the cache is opened and the stale-cache sweep runs exactly
 * ONCE per page session, however many assets call `getEngineAsset`. Resolves
 * `null` when `caches` is unavailable (Safari private mode, insecure
 * contexts) or the open/sweep itself throws — every caller then degrades to
 * a plain streaming fetch, byte-for-byte the pre-D-20 behavior.
 */
let cacheOpenPromise: Promise<Cache | null> | null = null;

/**
 * Set once a `cache.put` rejects (quota, storage pressure, an opaque-write
 * refusal). After that, every later write is skipped for the rest of the
 * page session so an over-quota device (iOS's ~50 MB Cache API limit against
 * 66.9 MB of assets — the same limit `vite.config.ts`'s `globIgnores`
 * comment records) does not thrash write-evict-write on every start; it
 * simply degrades to today's HTTP-cache behavior after the first refusal.
 */
let skipFurtherWrites = false;

/**
 * One in-flight populating fetch per asset id, keyed by id (not url — an
 * asset has exactly one URL per page session in practice, but the id is the
 * stable key `engineAssetProgress.ts` already uses). DELETED the moment it
 * settles, success or failure, so nothing is retained in module scope past
 * the fetch window — the next call always goes back through `cache.match`.
 */
const inflightByAssetId = new Map<EngineAssetId, Promise<ArrayBuffer>>();

// ─── Cache open + one-shot stale sweep ─────────────────────────────────────

function openEngineAssetCache(): Promise<Cache | null> {
  if (!cacheOpenPromise) {
    cacheOpenPromise = (async (): Promise<Cache | null> => {
      if (typeof caches === 'undefined') return null;
      try {
        const cache = await caches.open(ENGINE_ASSET_CACHE_NAME);
        // One-shot stale sweep: delete every OTHER engine-asset cache (a
        // different version left behind by a prior deploy). Filtered
        // strictly on the prefix — the Workbox caches serving the PWA's
        // offline shell live in the same CacheStorage and must never be
        // touched here.
        const keys = await caches.keys();
        const stale = keys.filter(
          (key) => key.startsWith(ENGINE_ASSET_CACHE_NAME_PREFIX) && key !== ENGINE_ASSET_CACHE_NAME,
        );
        await Promise.all(stale.map((key) => caches.delete(key)));
        return cache;
      } catch {
        return null;
      }
    })();
  }
  return cacheOpenPromise;
}

// ─── Streaming fetch + cache write ──────────────────────────────────────────

/**
 * Streams `url` (mirrors `ortRuntimeSource.ts`'s `fetchRuntimeBinary` /
 * `stockfishWorkerSource.ts`'s `fetchAndPublishSharedWasm` shape:
 * content-length coercion, per-chunk callback, assemble-then-return), then
 * AWAITS writing the complete body to `cache` before resolving — not fired
 * off, because a deterministic "the cache is populated before the caller
 * proceeds" is what makes the SECOND spawn measurably free, and it is a
 * local disk write. Throws on a genuine fetch failure — every current caller
 * already catches and degrades; swallowing here would hide a terminal
 * download failure the gate needs in order to offer Retry. NEVER writes a
 * non-ok or partial response to the cache — enforced (CR-01): a body short
 * of a trustworthy content-length throws as a failed download, and a body
 * whose completeness cannot be verified (no content-length, or a
 * content-encoded response whose header carries the wire size) is returned
 * to the caller but never persisted.
 */
async function streamAndCache(
  cache: Cache | null,
  url: string,
  onProgress: (loaded: number, total: number) => void,
  fallbackBytes: number,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`engineAssetCache: fetch failed for ${url} (status ${response.status})`);
  }

  // T-213-01-style coercion: a missing/zero/garbage content-length must
  // never produce a NaN/Infinity percent downstream.
  const declaredLength = Number(response.headers.get('content-length')) || 0;
  const total = declaredLength || fallbackBytes;

  // CR-01: content-length is only comparable to the DECODED byte count when
  // the response is not content-encoded — under gzip/br the header carries
  // the wire size, so an equality check would be a false truncation.
  const contentEncoding = response.headers.get('content-encoding');
  const lengthTrustworthy = declaredLength > 0 && (contentEncoding === null || contentEncoding === 'identity');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }

  // CR-01 fix: a stream can end with a clean `done: true` short of the
  // declared length (a proxy/CDN closing the socket in a way Fetch treats
  // as EOF rather than a network error). Before this guard, those truncated
  // bytes were written to CacheStorage and served back as complete on every
  // later spawn — a retry loop with no chance of succeeding until a
  // cache-version bump. A verified short read is a failed download: throw,
  // so the worker's retry loop / the gate's Retry re-fetches.
  if (lengthTrustworthy && loaded !== declaredLength) {
    throw new Error(
      `engineAssetCache: truncated download for ${url} (got ${loaded} of ${declaredLength} bytes)`,
    );
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  // CR-01 fix: only persist a body whose completeness was VERIFIED against a
  // trustworthy content-length. An unverifiable body (header absent, zero,
  // or content-encoded) is still returned — session create validates it —
  // but never cached, so unverified bytes can never be served back as
  // complete in a later session.
  if (cache && !skipFurtherWrites && lengthTrustworthy) {
    try {
      await cache.put(url, new Response(bytes));
    } catch (err) {
      // Quota / storage-pressure / an opaque-write refusal must never
      // strand the caller — the already-in-memory bytes are returned below
      // regardless. Reported ONCE: skipFurtherWrites means no later `put`
      // call in this page session can throw (and thus report) again.
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'engine-asset-cache' },
      });
      skipFurtherWrites = true;
    }
  }

  return bytes.buffer;
}

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * The single byte-ownership layer for engine assets (D-20). Cache-first:
 * `cache.match(url)` on a hit whose body has non-zero length reports
 * complete progress once (`onProgress(byteLength, byteLength)`) and resolves
 * those bytes — ZERO network. On a miss (or a zero-length entry, treated as
 * a miss), joins or starts a single-flight fetch keyed by `id`; every
 * JOINER receives an independent `slice(0)` copy so no two callers ever
 * share one ArrayBuffer instance — a caller may push what it receives into a
 * `postMessage` transfer list, which detaches it, exactly how `G-213-36`
 * happened upstream of this module.
 *
 * The single-flight entry is deleted the moment it settles (success or
 * failure) — nothing is retained in module scope past the fetch window, so
 * the next call always goes back through `cache.match`. This is a
 * DELIBERATE, easy-to-lose invariant: a promise memoised for the whole page
 * session (the shape `ortRuntimeSource.ts`/`stockfishWorkerSource.ts` use
 * for their OWN single fetch-per-page-load) would retain the bytes in module
 * scope, which is precisely the RAM cost D-20 removes.
 *
 * NEVER swallows a fetch failure — throws exactly as `streamAndCache` does;
 * every current caller already catches and degrades.
 */
export function getEngineAsset(
  id: EngineAssetId,
  url: string,
  onProgress: (loaded: number, total: number) => void,
  fallbackBytes: number,
): Promise<ArrayBuffer> {
  const existing = inflightByAssetId.get(id);
  if (existing) {
    return existing.then((bytes) => bytes.slice(0));
  }

  const populating = (async (): Promise<ArrayBuffer> => {
    const cache = await openEngineAssetCache();
    if (cache) {
      try {
        const match = await cache.match(url);
        if (match) {
          const bytes = await match.arrayBuffer();
          if (bytes.byteLength > 0) {
            onProgress(bytes.byteLength, bytes.byteLength);
            return bytes;
          }
        }
      } catch {
        // Any cache-read failure degrades to a miss and falls through to
        // fetch — a broken CacheStorage read must never block engine
        // startup.
      }
    }
    return streamAndCache(cache, url, onProgress, fallbackBytes);
  })();

  // Registered synchronously (before any await inside the IIFE above has a
  // chance to run) so concurrent same-tick callers for the same `id` join
  // this exact entry rather than each starting their own fetch.
  inflightByAssetId.set(id, populating);
  // `.finally()` returns a NEW promise that also rejects when `populating`
  // does — the caller already handles the ORIGINAL `populating` rejection
  // (returned below), but this derived cleanup-only chain needs its own
  // no-op `.catch()` or Node/the browser reports it as a second, unhandled
  // rejection for the same underlying failure.
  populating
    .finally(() => {
      inflightByAssetId.delete(id);
    })
    .catch(() => {
      // Cleanup-only chain — the real error is already surfaced to every
      // caller via the returned `populating` promise itself.
    });
  return populating;
}

/** Test-only: mirrors `resetOrtRuntimeSourceForTests()` / `resetStockfishWorkerSourceForTests()`. */
export function resetEngineAssetCacheForTests(): void {
  cacheOpenPromise = null;
  skipFurtherWrites = false;
  inflightByAssetId.clear();
}
