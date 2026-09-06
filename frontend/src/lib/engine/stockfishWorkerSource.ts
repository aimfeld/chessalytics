/**
 * stockfishWorkerSource — the single owner of Stockfish Worker construction
 * (Phase 213-08, G-213-35).
 *
 * Bug fix: every Stockfish Worker used to load its own copy of the vendored
 * `.wasm` (`useStockfishEngine`, each `workerPool` slot, both grading hooks)
 * — between 5 and 8 independent 7,295,411-byte fetches per analysis-board
 * page load, all issued in the same tick so the HTTP cache could never dedupe
 * them (29-51 MB of duplicate transfer). This module fetches the `.wasm`
 * ONCE on the main thread via `engineAssetCache.ts`'s `getEngineAsset()` —
 * the same cache-first layer every engine asset now shares (Phase 213-12,
 * D-20) — publishes the bytes as an `application/wasm` Blob object URL, and
 * hands that URL to every Worker through the vendored glue's OWN
 * already-shipped wasm-path override: the worker script reads its `.wasm`
 * URL out of `self.location.hash` (`stockfish-18-lite-single.js` worker
 * entry — `u = decodeURIComponent(hash[0] || …)`) and `instantiateWasm`
 * streams from exactly that URL. The vendored file is not edited — this is
 * the glue's own supported override, not a patch.
 *
 * D-08: the shared fetch is triggered ONLY at the spawn seams that already
 * existed (`ensureSpawned()`, each hook's worker-lifecycle effect) — nothing
 * is fetched at import time and nothing is fetched speculatively. No timeout,
 * no `saveData`/`effectiveType`/`navigator.connection` read, no trigger of
 * its own — a wall-clock timeout on a 7.3 MB body would fire on exactly the
 * throttled connections this fix exists to help.
 *
 * T-213-07: a failed shared fetch must never be able to break engine spawn —
 * `ensureStockfishWorkerUrl()` NEVER rejects; every failure mode (network
 * rejection, non-ok response, absent `response.body`, absent
 * `URL.createObjectURL`/`Blob`) is caught, reported once to Sentry, and
 * resolves `null`. A `null` shared URL (quick 260905-rhc, D-05) still passes
 * `STOCKFISH_ENGINE_WASM_PATH` through the glue's location-hash override —
 * NOT the pre-fix "construct against the served path alone" behavior,
 * because the vendored glue's OWN fallback derives an unversioned `.wasm`
 * URL from `location.pathname` (which drops the query string), and that
 * would be the one unversioned runtime URL left in the system after this
 * fix. See `createStockfishWorker()`'s own doc comment.
 *
 * `ensureStockfishWorkerUrl()` stays memoised for the WHOLE page session
 * (unlike `ortRuntimeSource.ts`'s per-call `getEngineAsset()` routing) — the
 * published Blob object URL is a Worker-construction HANDLE, not a byte
 * cache, and `workerPool.ts`'s `replaceDeadSlot()` depends on getting the
 * SAME valid URL for the life of the page. This retention is deliberate and
 * is NOT the kind of in-memory byte patch D-20 retires.
 */

import * as Sentry from '@sentry/react';
import {
  markEngineAssetPending,
  reportEngineAssetProgress,
  STOCKFISH_WASM_BYTES_FALLBACK,
} from './engineAssetProgress';
import { getEngineAsset, versionedEngineAssetUrl } from './engineAssetCache';
import { createInertWorker, isDevStockfishDisabled } from './devEngineSwitches';

// ─── Named constants (CLAUDE.md no-magic-numbers) ──────────────────────────

/**
 * Versioned URL (path plus the shared `?v=<n>` query — quick 260905-rhc) to
 * the vendored Stockfish engine glue served from public/engine/.
 */
export const STOCKFISH_ENGINE_GLUE_PATH = versionedEngineAssetUrl('/engine/stockfish-18-lite-single.js');

/**
 * Versioned URL (path plus the shared `?v=<n>` query — quick 260905-rhc) to
 * the vendored Stockfish `.wasm` binary served from public/engine/.
 */
export const STOCKFISH_ENGINE_WASM_PATH = versionedEngineAssetUrl('/engine/stockfish-18-lite-single.wasm');

// ─── Module-level singleton state ──────────────────────────────────────────

/**
 * Memoised in a module-level promise so the first caller starts the fetch
 * and every later caller (concurrent or sequential) joins the SAME promise —
 * this is what makes "N callers, one fetch" true regardless of how many
 * Workers the page constructs.
 */
let sharedUrlPromise: Promise<string | null> | null = null;

/** The currently-published object URL, or null before any fetch has resolved (or after a test reset). Never revoked in production — see the doc comment on `resetStockfishWorkerSourceForTests`. */
let publishedObjectUrl: string | null = null;

/**
 * Resolves the `.wasm` bytes through `engineAssetCache.ts`'s cache-first
 * `getEngineAsset()` (Phase 213-12, D-20 — this is the smallest of the three
 * asset migrations: only the byte source changes, everything else in this
 * module stays as it is), reports progress under the `stockfish-wasm` asset
 * id, and resolves the published Blob object URL. Never throws or rejects —
 * every failure mode is caught by the caller.
 */
async function fetchAndPublishSharedWasm(): Promise<string> {
  const buffer = await getEngineAsset(
    'stockfish-wasm',
    STOCKFISH_ENGINE_WASM_PATH,
    (loaded, total) => reportEngineAssetProgress('stockfish-wasm', loaded, total),
    STOCKFISH_WASM_BYTES_FALLBACK,
  );

  // The glue's `instantiateWasm` compiles with `WebAssembly.instantiateStreaming`,
  // which requires an `application/wasm` MIME type — a wrong type here would
  // surface as a hard spawn failure, not a silent fallback (T-213-08-06).
  const blob = new Blob([buffer], { type: 'application/wasm' });
  const url = URL.createObjectURL(blob);
  publishedObjectUrl = url;
  return url;
}

/**
 * The single owner of the shared Stockfish `.wasm` fetch. Memoised: the
 * first call synchronously registers `'stockfish-wasm'` as pending (CR-02 —
 * this MUST happen before the fetch is even awaited, in the same tick) and
 * starts the streaming fetch; every later call (however many, however
 * concurrent) joins the same promise rather than issuing a second `fetch`.
 *
 * NEVER rejects (T-213-07) — a failed fetch resolves `null` instead, so
 * `createStockfishWorker(null)` degrades every caller to today's direct
 * construction against the served path rather than stranding queued work
 * behind a rejected promise.
 */
export function ensureStockfishWorkerUrl(): Promise<string | null> {
  if (sharedUrlPromise) return sharedUrlPromise;
  // SEED-158 dev bisect switch: no fetch, no pending asset, no Blob on the main thread.
  if (isDevStockfishDisabled()) return Promise.resolve(null);

  // CR-02: registered synchronously, before `fetchAndPublishSharedWasm()` is
  // even invoked — the async function's first `await` has not run yet, so
  // this happens in the exact same tick as the first caller's request.
  markEngineAssetPending('stockfish-wasm');

  sharedUrlPromise = fetchAndPublishSharedWasm().catch((err: unknown) => {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { source: 'stockfish-worker-source' },
    });
    return null;
  });
  return sharedUrlPromise;
}

/**
 * Constructs a Stockfish Worker, always appending a `#`-encoded location
 * hash — the vendored glue reads its wasm URL out of `self.location.hash`
 * and streams from exactly that URL (see this file's header comment), so
 * this is the glue's own supported override, not a patch of a vendored file.
 * `encodeURIComponent` never emits a raw comma, which matters because the
 * glue's pthread guard tests `self.location.hash.split(',')[1] === 'worker'`
 * — a comma in the hash would collide with that split.
 *
 * `sharedUrl === null` (never fetched yet, or the shared fetch failed) hands
 * the glue `STOCKFISH_ENGINE_WASM_PATH` explicitly (D-05, quick 260905-rhc)
 * rather than letting the glue's OWN fallback derive one — that fallback
 * reads `location.origin + location.pathname`, and `pathname` excludes the
 * query string, so an un-hinted degraded spawn would fetch the one
 * unversioned runtime URL left in the system. A non-null `sharedUrl` (the
 * Blob object URL published by `ensureStockfishWorkerUrl()`) is passed the
 * same way.
 */
export function createStockfishWorker(sharedUrl: string | null): Worker {
  // SEED-158 dev bisect switch (`?dev-stockfish=off`): hand every consumer a
  // worker that never speaks UCI, so the page runs Maia with zero Stockfish.
  if (isDevStockfishDisabled()) return createInertWorker();
  const wasmHashUrl = sharedUrl ?? STOCKFISH_ENGINE_WASM_PATH;
  return new Worker(`${STOCKFISH_ENGINE_GLUE_PATH}#${encodeURIComponent(wasmHashUrl)}`);
}

/**
 * Test-only: clears the memoised promise and revokes any published object
 * URL, mirroring `resetEngineAssetsForTests()`. Production code must NEVER
 * revoke the object URL — `replaceDeadSlot()` re-creates workers for the
 * life of the page and needs the URL to stay valid; the retained 7.3 MB Blob
 * buys 29-51 MB not transferred (T-213-08-04, accepted).
 */
export function resetStockfishWorkerSourceForTests(): void {
  sharedUrlPromise = null;
  if (publishedObjectUrl !== null) {
    URL.revokeObjectURL(publishedObjectUrl);
    publishedObjectUrl = null;
  }
}
