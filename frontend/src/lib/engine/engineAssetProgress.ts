/**
 * engineAssetProgress — a module-level singleton store (`useSyncExternalStore`-
 * shaped, mirrors `useFlawFilterStore.ts`'s pattern) tracking download progress
 * and readiness for every engine asset (Maia model, Stockfish WASM) across the
 * whole app. Outlives any single component (D-07): an in-flight fetch runs in
 * `maia-worker.js`, not in a component, so this store survives unmount and the
 * next mount of `EngineReadyGate` (or any other consumer) sees the CURRENT
 * state immediately rather than restarting from zero.
 *
 * This phase (213-01) only drives the `'maia-model'` id end to end. Phase
 * 213-03 adds `'stockfish-wasm'` reporting; both ids share this one registry
 * from the start (see 213-01-PLAN.md's "Assumption-delta decision") so the
 * blend-0 case is one variant of the general N-asset shape rather than a
 * special path a second asset has to be bolted onto later.
 */

import type { MaiaFailureKind } from '@/lib/maiaWorkerErrors';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A discriminated literal union — never a bare `string` (CLAUDE.md). */
export type EngineAssetId = 'maia-model' | 'stockfish-wasm' | 'ort-runtime';

/**
 * The full status union ships now even though Plan 04 owns the
 * `unsupported`/`failed` transitions and their UI copy — the type must not
 * change under later plans.
 */
export type EngineAssetStatus = 'idle' | 'unsupported' | 'downloading' | 'ready' | 'failed';

/**
 * Why the store reports `'unsupported'` (hotfix 2026-09-06, SEED-158):
 * `'no-wasm-simd'` is the D-13 probe (the device can never run the model);
 * `'ios-webkit'` is the iOS/iPadOS gate (the device COULD run it, but Safari
 * kills the page when it does — see `iosWebKit.ts`). `EngineReadyGate` shows
 * different copy for each, so the iOS user is not told their device lacks a
 * capability it actually has.
 */
export type EngineUnsupportedReason = 'no-wasm-simd' | 'ios-webkit';

interface EngineAssetEntry {
  loaded: number;
  total: number;
  done: boolean;
}

export interface EngineAssetsSnapshot {
  status: EngineAssetStatus;
  /** `noUncheckedIndexedAccess` is on — narrow every read before use. */
  assets: Partial<Record<EngineAssetId, EngineAssetEntry>>;
  /**
   * Quick 260829-tku: which Maia worker failure bucket caused the current
   * `'failed'` status, or `null` when there is no failure (or an unclassified
   * one). This store is engine-generic (it also tracks Stockfish and the ORT
   * runtime), while `MaiaFailureKind` is Maia-specific — the Stockfish pool
   * and `useStockfishEngine` call sites therefore never pass one, and this
   * field simply stays `null` for those failures.
   */
  failureKind: MaiaFailureKind | null;
  /** Which gate produced the current `'unsupported'` status, or `null` in every other status. */
  unsupportedReason: EngineUnsupportedReason | null;
}

// ─── Named constants (CLAUDE.md no-magic-numbers) ──────────────────────────

/**
 * Raw byte sizes verified live 2026-08-28. Defense-in-depth fallback for a
 * missing/garbage `Content-Length` (213-RESEARCH.md Pitfall 3) — used as the
 * percent denominator before an asset has reported anything, and as the
 * worker-side coercion target when the header itself is untrustworthy.
 */
export const MAIA_MODEL_BYTES_FALLBACK = 45_683_686;
export const STOCKFISH_WASM_BYTES_FALLBACK = 7_295_411;

/**
 * Phase 213-09 (G-213-35), re-verified live 2026-09-05 at onnxruntime-web
 * 1.29.0: the onnxruntime-web runtime binary fallback. TWO real sizes exist
 * (13,961,845 wasm-only, 25,749,873 WebGPU/asyncify — `ortRuntimeSource.ts`'s
 * own named constants), and the backend decision isn't known yet at the
 * moment `markEngineAssetPending('ort-runtime')` fires (the adapter probe is
 * itself async, and this placeholder is registered synchronously before it
 * resolves). Deliberately the SMALLER wasm-only figure: most devices lack the
 * WebGPU `shader-f16` feature Task 1's probe requires, so the smaller
 * estimate is the representative default, and it self-corrects to the real
 * (`Content-Length`-derived) total the moment the first byte of THIS asset
 * arrives — before that, the placeholder shows 0% regardless of which figure
 * was guessed, so there is no user-visible "backwards" jump to avoid. The
 * gate must not promise 25.7 MB to a device that will only ever fetch
 * 14.0 MB.
 */
export const ORT_RUNTIME_BYTES_FALLBACK = 13_961_845;

export const ENGINE_ASSET_FALLBACK_BYTES: Record<EngineAssetId, number> = {
  'maia-model': MAIA_MODEL_BYTES_FALLBACK,
  'stockfish-wasm': STOCKFISH_WASM_BYTES_FALLBACK,
  'ort-runtime': ORT_RUNTIME_BYTES_FALLBACK,
};

/**
 * G-213-19b: the required-asset set is now the SAME frozen triple for every
 * session, with no persona/blend input of any kind (Phase 213-09 adds
 * 'ort-runtime' as the third member — G-213-35). Declared once at module
 * scope (never a fresh array literal inside `requiredEngineAssets`) so every
 * caller gets the SAME array reference on every call — this referential
 * stability is what lets `EngineReadyGate` drop its `useMemo` wrapper without
 * making `useEngineAssets`' own memo (keyed on this array) recompute on every
 * render.
 */
export const ALL_ENGINE_ASSETS: readonly EngineAssetId[] = [
  'maia-model',
  'stockfish-wasm',
  'ort-runtime',
];

/** D-10's asset names shown to the user. */
export const ENGINE_ASSET_LABEL: Record<EngineAssetId, string> = {
  'maia-model': 'Maia model',
  'stockfish-wasm': 'Stockfish engine',
  'ort-runtime': 'Runtime engine',
};

export const ENGINE_ASSET_SEEN_KEY_PREFIX = 'flawchess.engineAsset.seen.';

/** Value written to the seen-flag key — existence check reads for this exact string. */
const SEEN_FLAG_VALUE = '1';

/**
 * Phase 213-10 (G-213-35 third part): the rounded-percent scale/bounds used
 * to decide whether a progress tick is worth a listener notification. Kept
 * as named constants rather than bare `100`/`0` literals (CLAUDE.md).
 */
const PERCENT_ROUND_SCALE = 100;
const MIN_ROUNDED_PERCENT = 0;
const MAX_ROUNDED_PERCENT = 100;

// ─── Module-level singleton state ──────────────────────────────────────────

let currentStatus: EngineAssetStatus = 'idle';
let currentAssets: Partial<Record<EngineAssetId, EngineAssetEntry>> = {};
/** Quick 260829-tku: the classified kind behind the current `'failed'` status. */
let currentFailureKind: MaiaFailureKind | null = null;
/** Hotfix 2026-09-06 (SEED-158): the gate behind the current `'unsupported'` status. */
let currentUnsupportedReason: EngineUnsupportedReason | null = null;
/**
 * Cached snapshot object — referentially stable between mutations so
 * `useSyncExternalStore` (in `useEngineAssets.ts`) does not loop forever.
 * Only `commit()` below may reassign this.
 */
let cachedSnapshot: EngineAssetsSnapshot = {
  status: currentStatus,
  assets: currentAssets,
  failureKind: currentFailureKind,
  unsupportedReason: currentUnsupportedReason,
};
const listeners = new Set<() => void>();

/**
 * Phase 213-10 (G-213-35 third part): the last rounded per-asset percent a
 * listener was actually notified at, keyed by asset id. Used ONLY to decide
 * whether a `reportEngineAssetProgress` call is worth a notification — it
 * never gates the snapshot refresh itself (see `refreshSnapshot` vs
 * `notifyListeners` split below).
 */
const lastNotifiedPercentById = new Map<EngineAssetId, number>();

/** Clamped rounded percent for one asset's `loaded`/`total` pair. */
function roundedAssetPercent(loaded: number, total: number): number {
  const raw = Math.round((loaded / total) * PERCENT_ROUND_SCALE);
  return Math.min(Math.max(raw, MIN_ROUNDED_PERCENT), MAX_ROUNDED_PERCENT);
}

/**
 * Rebuilds the cached snapshot from current state. ALWAYS called by every
 * mutator, unconditionally — `getEngineAssetsSnapshot()` must be exact
 * immediately after any mutator, with no flush and no timer, so a render
 * triggered by any cause other than a store notification still observes the
 * true current bytes and `useSyncExternalStore`'s tearing guarantee holds.
 */
function refreshSnapshot(): void {
  cachedSnapshot = {
    status: currentStatus,
    assets: currentAssets,
    failureKind: currentFailureKind,
    unsupportedReason: currentUnsupportedReason,
  };
}

/** Notifies every subscriber. Only the caller decides whether this runs. */
function notifyListeners(): void {
  for (const listener of listeners) listener();
}

/**
 * Refresh + notify, unconditionally. Used by every mutator EXCEPT
 * `reportEngineAssetProgress`, which gates the notify half on whether the
 * rounded per-asset percent (or status) actually changed — see that
 * function's own doc comment for why (G-213-35 third part).
 */
function commit(): void {
  refreshSnapshot();
  notifyListeners();
}

// ─── Mutators ───────────────────────────────────────────────────────────────

/**
 * Bug fix (CR-02, 213-REVIEW.md): registers `id` as in-flight — an entry
 * with `loaded: 0, done: false` — the MOMENT its spawn/fetch actually begins,
 * without waiting for the asset's first real `progress` message.
 *
 * `markEngineAssetReady`'s readiness check below iterates
 * `Object.keys(currentAssets)`, i.e. every id that has "reported something".
 * When two required assets of very different sizes spawn concurrently from
 * the same provider bring-up effect (Stockfish's ~7.3 MB `.wasm` vs Maia's
 * ~45.7 MB model), it is the common case — not a rare race — that the
 * smaller asset completes and calls `markEngineAssetReady` BEFORE the larger
 * one has posted even its first `progress` event. At that moment,
 * `currentAssets` would contain only the finished asset's key, so `allDone`
 * would wrongly evaluate `true`. Calling this at the synchronous moment each
 * spawn is triggered (`workerPool.ts`'s `ensureSpawned()`,
 * `maiaWorkerHost.ts`'s `spawn()`, `useStockfishEngine.ts`'s worker-lifecycle
 * effect) closes that gap: since every real progress/ready message requires
 * at least one browser task tick to arrive, every asset spawned in the SAME
 * synchronous effect is guaranteed to have an entry before any of them can
 * finish.
 *
 * Deliberately does nothing beyond registering the placeholder — no-ops if
 * `id` already has an entry, so a later call can never reset real progress
 * (or an already-`done` asset) back to zero. G-213-19b: both providers are
 * now warmed unconditionally for every persona, so both ids are ALWAYS
 * registered before either can finish — the CR-02 concurrent-spawn race this
 * function closes is therefore the ONLY case `allDone` has to handle, not an
 * uncommon one layered on top of a per-persona subset.
 */
export function markEngineAssetPending(id: EngineAssetId): void {
  if (currentAssets[id]) return;
  currentAssets = {
    ...currentAssets,
    [id]: { loaded: 0, total: ENGINE_ASSET_FALLBACK_BYTES[id], done: false },
  };
  commit();
}

/**
 * Records progress for `id`. Defensively coerces a non-finite, zero, or
 * negative `total` to the fallback byte count (T-213-01 — a malformed
 * `Content-Length` must never produce a `NaN`/`Infinity` percent), clamps
 * `loaded` into `[0, safeTotal]`, and keeps `loaded` MONOTONIC per id
 * (`Math.max` against the stored value) so two sources reporting the same
 * asset cannot make the bar go backwards. Sets `status` to `'downloading'`
 * unless it is already `'ready'`.
 *
 * Bug fix (G-213-35 third part, 213-10-PLAN.md): `fetchModelBuffer()` calls
 * this once per stream chunk with no threshold — a ~45.7 MB model at typical
 * chunk sizes notified every listener over a thousand times, and
 * `Analysis.tsx`'s page-wide subscription re-rendered the whole 3,600-line
 * board on every one of them. With every byte already transferred, the main
 * thread fell minutes behind a message queue it could not drain, so the
 * gate's own bar sat stuck at a stale percent long after the network tab
 * showed 100%. The STATE update (`currentAssets`/`cachedSnapshot` via
 * `refreshSnapshot()`) stays fully synchronous and unconditional on every
 * call — only the listener NOTIFICATION is gated, on whether the rounded
 * per-asset percent actually changed or this call caused a status
 * transition (`idle -> downloading`). This bounds notifications to ~101 per
 * asset (0..100 inclusive) while a render triggered by any other cause still
 * observes the exact current byte count.
 *
 * Rejected alternative: batching the notification behind
 * `requestAnimationFrame`. It achieves a similar bound but drags `rAF` into
 * a store with a large synchronous test suite, making every assertion
 * timing-dependent — the percent-change gate below gets the same bound while
 * staying fully synchronous and deterministic.
 */
export function reportEngineAssetProgress(id: EngineAssetId, loaded: number, total: number): void {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : ENGINE_ASSET_FALLBACK_BYTES[id];
  const clampedLoaded = Math.min(Math.max(loaded, 0), safeTotal);
  const existing = currentAssets[id];
  const monotonicLoaded = existing ? Math.max(existing.loaded, clampedLoaded) : clampedLoaded;

  currentAssets = {
    ...currentAssets,
    [id]: { loaded: monotonicLoaded, total: safeTotal, done: existing?.done ?? false },
  };
  const previousStatus = currentStatus;
  if (currentStatus !== 'ready') {
    currentStatus = 'downloading';
  }
  // Snapshot refresh is ALWAYS unconditional — see refreshSnapshot()'s doc
  // comment. Only the notify half below is gated.
  refreshSnapshot();

  const roundedPercent = roundedAssetPercent(monotonicLoaded, safeTotal);
  const percentChanged = lastNotifiedPercentById.get(id) !== roundedPercent;
  const statusChanged = previousStatus !== currentStatus;
  if (percentChanged || statusChanged) {
    lastNotifiedPercentById.set(id, roundedPercent);
    notifyListeners();
  }
}

/**
 * Marks `id` fully downloaded and ready, writes the localStorage seen-flag
 * (so a later mount's `engineGateRequired` skips the gate), and recomputes
 * `status` to `'ready'` once EVERY currently-registered id is done.
 */
export function markEngineAssetReady(id: EngineAssetId): void {
  const existing = currentAssets[id];
  const total = existing?.total ?? ENGINE_ASSET_FALLBACK_BYTES[id];

  currentAssets = { ...currentAssets, [id]: { loaded: total, total, done: true } };

  try {
    localStorage.setItem(ENGINE_ASSET_SEEN_KEY_PREFIX + id, SEEN_FLAG_VALUE);
  } catch {
    // QuotaExceededError / Safari private mode — degrade to "gate shows every
    // visit for this asset", never a crash (mirrors botGameSnapshot.ts).
  }

  // CR-02: this is only correct because every spawn call site now registers
  // its id via `markEngineAssetPending()` BEFORE any real progress/ready
  // message can arrive (see that function's doc comment) — so a
  // still-downloading required asset is guaranteed to already have a
  // `done: false` entry here, rather than being silently absent from
  // `Object.values(currentAssets)` and treated as done by omission.
  const allDone = Object.values(currentAssets).every((entry) => entry?.done);
  if (allDone) {
    currentStatus = 'ready';
  }
  commit();
}

/**
 * D-13: the device cannot run any engine asset at all (WASM-SIMD probe
 * failed). Plan 04 owns this state's UI; Task 1 calls it from the
 * `wasmSimd.ts` choke point in `maiaWorkerHost.ts`.
 *
 * Hotfix 2026-09-06 (SEED-158): also reached from the iOS/iPadOS gate at the
 * same choke point, with `reason: 'ios-webkit'`, so the gate's copy can say
 * what is actually going on instead of "your device lacks the technology".
 */
export function markEngineAssetsUnsupported(reason: EngineUnsupportedReason): void {
  currentStatus = 'unsupported';
  currentUnsupportedReason = reason;
  commit();
}

/**
 * A specific asset's download/init failed. Plan 04 owns this state's UI.
 *
 * Quick 260829-tku: `failureKind` is OPTIONAL so the Stockfish pool and
 * `useStockfishEngine` call sites (which have no Maia-specific classification
 * to offer) keep compiling and keep today's behavior unchanged. When passed,
 * it records which `MaiaFailureKind` bucket caused the failure so
 * `EngineReadyGate` can pick a matching terminal variant.
 *
 * Precedence: `failureKind ?? currentFailureKind` — a classified failure
 * wins and is never overwritten by a LATER unclassified one (e.g. the
 * Stockfish pool giving up on a device that is already out of memory). The
 * only exit from a terminal failure is Retry (`markEngineAssetsRetrying`,
 * below), which clears the field, so there is no stale-state window where an
 * old classification could survive past the failure it described.
 */
export function markEngineAssetFailed(id: EngineAssetId, failureKind?: MaiaFailureKind): void {
  const existing = currentAssets[id];
  currentAssets = {
    ...currentAssets,
    [id]: {
      loaded: existing?.loaded ?? 0,
      total: existing?.total ?? ENGINE_ASSET_FALLBACK_BYTES[id],
      done: false,
    },
  };
  currentStatus = 'failed';
  currentFailureKind = failureKind ?? currentFailureKind;
  commit();
}

/**
 * Bug fix (WR-02, 213-REVIEW.md): resets `id` back to a fresh in-flight
 * download (`loaded: 0, done: false`, `total` preserved) WITHOUT touching
 * `status` or any other asset's entry. Distinct from both
 * `markEngineAssetFailed()` (a user-facing terminal failure) and
 * `markEngineAssetsRetrying()` (D-15's manual Retry, which resets EVERY
 * not-done asset and flips `status` back to `'idle'`): this is the silent
 * mid-session self-heal path — `maiaWorkerHost.ts`'s `respawnPinnedToWasm`
 * (FLAWCHESS-9D), which re-fetches an asset the store may have already
 * marked `done: true` after a mid-inference WebGPU session death. Without
 * this reset, `useEngineAssets([id]).ready`/`.percent` would keep reporting
 * the asset 100% ready throughout the silent re-download — a real
 * state/reality mismatch, not merely cosmetic, since a caller gating new
 * work on `.ready` would proceed as if the asset were already loaded. Must
 * not touch `status`: a WebGPU->wasm respawn is not a user-facing failure,
 * and the gate must not reappear once it has already been passed.
 */
export function resetEngineAssetForRefetch(id: EngineAssetId): void {
  const existing = currentAssets[id];
  currentAssets = {
    ...currentAssets,
    [id]: { loaded: 0, total: existing?.total ?? ENGINE_ASSET_FALLBACK_BYTES[id], done: false },
  };
  // G-213-35 third part: clear the remembered notified percent for this id so
  // the new pass's first progress report is never swallowed as "unchanged"
  // just because it happens to round to the same percent the OLD pass was
  // last notified at.
  lastNotifiedPercentById.delete(id);
  commit();
}

/**
 * D-15: called by `EngineReadyGate`'s manual Retry button BEFORE
 * re-triggering `pool.warm()`/`queue.warm()`. Clears a `'failed'` status back
 * to `'idle'` so the gate re-renders in its downloading state on the next
 * progress/ready message.
 *
 * Bug fix (WR-01, 213-REVIEW.md): resets `loaded` back to `0` for every
 * NOT-yet-`done` entry (an already-`done` asset — e.g. Maia already ready
 * while only Stockfish failed — is left completely untouched, `total`
 * included). A fresh worker respawned after Retry re-fetches its asset
 * ENTIRELY from scratch (there is no resumable partial fetch, per
 * `maia-worker.js`'s own doc comment), but `reportEngineAssetProgress`'s
 * monotonic clamp (`Math.max(existing.loaded, ...)`) would otherwise never
 * let the fresh worker's first `progress(0, total)` message report BELOW the
 * failed attempt's old high-water mark — so a failure at 40/45.7 MB would
 * have the gate immediately jump back to ~87% and sit there while a
 * genuinely fresh download runs underneath, instead of visibly restarting
 * the bar. Every localStorage seen flag stays untouched either way: a retry
 * is "try the download again", not "forget everything this asset already
 * proved".
 */
export function markEngineAssetsRetrying(): void {
  currentStatus = 'idle';
  // Quick 260829-tku: clear the recorded failure kind so a retried-then-
  // differently-failed session never shows stale out-of-memory copy.
  currentFailureKind = null;
  currentAssets = Object.fromEntries(
    Object.entries(currentAssets).map(([id, entry]) =>
      entry.done ? [id, entry] : [id, { ...entry, loaded: 0 }],
    ),
  ) as Partial<Record<EngineAssetId, EngineAssetEntry>>;
  commit();
}

// ─── Subscription (useSyncExternalStore shape) ─────────────────────────────

export function subscribeEngineAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEngineAssetsSnapshot(): EngineAssetsSnapshot {
  return cachedSnapshot;
}

// ─── Gate predicates ────────────────────────────────────────────────────────

/**
 * G-213-19b (supersedes D-06): the required-asset set is unconditional — every
 * session downloads BOTH `maia-model` and `stockfish-wasm`, with no persona or
 * blend input of any kind. The accepted cost is the one D-06 refused: a
 * blend-0 rung now waits for the extra 7.3 MB of Stockfish it can never use
 * (45.7 -> 53.0 MB, ~16% longer). Returns the same `ALL_ENGINE_ASSETS`
 * reference on every call — referential stability, not a fresh array.
 */
export function requiredEngineAssets(): readonly EngineAssetId[] {
  return ALL_ENGINE_ASSETS;
}

/**
 * Reads the seen-flag for `id`, wrapped in try/catch (Safari private mode
 * throws on `localStorage` access). Returning `false` on throw is the SAFE
 * direction — it shows the gate rather than silently skipping it.
 */
export function hasSeenEngineAsset(id: EngineAssetId): boolean {
  try {
    return localStorage.getItem(ENGINE_ASSET_SEEN_KEY_PREFIX + id) === SEEN_FLAG_VALUE;
  } catch {
    return false;
  }
}

/**
 * D-04's cache-miss gate predicate, evaluated synchronously at mount with NO
 * timer and no elapsed-wait threshold. G-213-19b (supersedes D-06): the
 * required set is `requiredEngineAssets()`'s unconditional pair for EVERY
 * session — returns `true` iff ANY of those two assets is both (a) not
 * `done` in the current snapshot and (b) not present in the localStorage
 * seen flags. A blend-0 rung on a clean cache is therefore gated until the
 * full 53.0 MB bundle has landed, not just Maia's 45.7 MB. A partially-cached
 * device (only one of the two assets seen) is still gated. Stockfish's
 * readiness source is `WorkerPool`'s first `readyok`
 * (`workerPool.ts::markPoolReady`), which marks `stockfish-wasm` ready in
 * this same store.
 *
 * Accepted false-negative: an evicted HTTP cache with the seen-flag still
 * present degrades to today's (pre-Phase-213) behavior — never worse.
 */
export function engineGateRequired(): boolean {
  const required = requiredEngineAssets();
  return required.some((id) => !currentAssets[id]?.done && !hasSeenEngineAsset(id));
}

// ─── Test-only ──────────────────────────────────────────────────────────────

/** Test-only: mirrors `resetMaiaWorkerHostForTests()` — clears state, listeners, and the cached snapshot. */
export function resetEngineAssetsForTests(): void {
  currentStatus = 'idle';
  currentAssets = {};
  currentFailureKind = null;
  currentUnsupportedReason = null;
  cachedSnapshot = {
    status: currentStatus,
    assets: currentAssets,
    failureKind: currentFailureKind,
    unsupportedReason: currentUnsupportedReason,
  };
  listeners.clear();
  lastNotifiedPercentById.clear();
}
