/**
 * useEngineAssets — the D-10/D-11 read model over `engineAssetProgress.ts`'s
 * module-level store. Subscribes via `useSyncExternalStore` and derives the
 * byte-weighted aggregate percent, the currently-in-flight asset's label, and
 * overall readiness for whatever asset set the caller currently needs.
 *
 * A caller that only needs the coarse status (not byte-level progress — e.g.
 * a page deciding whether to mount the gate at all) should use
 * `useEngineAssetStatus()` below instead: it returns a PRIMITIVE, so
 * `useSyncExternalStore` can bail out by `Object.is` on every progress tick.
 * This hook always returns a fresh object per render (via `useMemo` keyed on
 * `snapshot`, which changes reference on every store notification), so any
 * component calling it re-renders on every notification — correct for
 * `EngineReadyGate`, which needs the byte-level data, but wrong for a
 * component that only reads `.status` (G-213-35 third part).
 */

import { useMemo, useSyncExternalStore } from 'react';
import {
  ENGINE_ASSET_FALLBACK_BYTES,
  ENGINE_ASSET_LABEL,
  getEngineAssetsSnapshot,
  subscribeEngineAssets,
  type EngineAssetId,
  type EngineAssetStatus,
} from '@/lib/engine/engineAssetProgress';
import type { MaiaFailureKind } from '@/lib/maiaWorkerErrors';

const MIN_PERCENT = 0;
const MAX_PERCENT = 100;

export interface EngineAssetsState {
  status: EngineAssetStatus;
  /** Byte-weighted aggregate across `required`, clamped to [0, 100], rounded to an integer. */
  percent: number;
  /** `ENGINE_ASSET_LABEL` of the first not-yet-done id in `required`, or `null` once all are done. */
  activeAssetLabel: string | null;
  /** Byte-weighted aggregate bytes downloaded so far across `required`. */
  loadedBytes: number;
  /** Byte-weighted aggregate size of `required` (the `percent` denominator). */
  totalBytes: number;
  /** True once every id in `required` is done. */
  ready: boolean;
  /**
   * Quick 260829-tku: which Maia worker failure bucket caused the current
   * `'failed'` status, or `null` when there is no failure (or an unclassified
   * one). Read straight off the snapshot — it needs no per-`required` derivation.
   */
  failureKind: MaiaFailureKind | null;
}

/**
 * Derives byte-weighted download progress across `required` (D-11: NOT a
 * per-asset average — Maia's 45.7 MB and Stockfish's 7.3 MB must not
 * contribute equally). Callers should pass a referentially stable array (see
 * `EngineReadyGate.tsx`'s `useMemo`) or this hook's own memo recomputes every
 * render for no reason.
 */
export function useEngineAssets(required: readonly EngineAssetId[]): EngineAssetsState {
  const snapshot = useSyncExternalStore(subscribeEngineAssets, getEngineAssetsSnapshot);

  return useMemo<EngineAssetsState>(() => {
    let loadedSum = 0;
    let totalSum = 0;
    let activeAssetLabel: string | null = null;

    for (const id of required) {
      const entry = snapshot.assets[id];
      const total = entry?.total ?? ENGINE_ASSET_FALLBACK_BYTES[id];
      const loaded = entry?.loaded ?? 0;
      loadedSum += loaded;
      totalSum += total;
      if (activeAssetLabel === null && !entry?.done) {
        activeAssetLabel = ENGINE_ASSET_LABEL[id];
      }
    }

    const rawPercent = totalSum > 0 ? (loadedSum / totalSum) * MAX_PERCENT : MIN_PERCENT;
    const percent = Math.round(Math.min(Math.max(rawPercent, MIN_PERCENT), MAX_PERCENT));
    const ready = required.every((id) => snapshot.assets[id]?.done ?? false);

    return {
      status: snapshot.status,
      percent,
      activeAssetLabel: ready ? null : activeAssetLabel,
      loadedBytes: loadedSum,
      totalBytes: totalSum,
      ready,
      failureKind: snapshot.failureKind,
    };
  }, [snapshot, required]);
}

/**
 * useEngineAssetStatus — Phase 213-10 (G-213-35 third part): a narrow
 * companion to `useEngineAssets` for callers that only need the coarse
 * `EngineAssetStatus`, not byte-level progress. Returning the primitive
 * directly (rather than a field plucked from a fresh object each call) is
 * the whole point: `useSyncExternalStore` compares successive snapshots with
 * `Object.is`, so a byte-only progress tick — which changes `loadedBytes`
 * but not `status` — is skipped entirely, and the calling component does not
 * re-render.
 *
 * `Analysis.tsx` is the motivating caller: it used to call `useEngineAssets`
 * for a single boolean (`status !== 'unsupported'`), which subscribed the
 * whole 3,600-line page to every download chunk. Use this hook wherever only
 * the status matters — `EngineReadyGate` still needs the full
 * `useEngineAssets` above for its byte-level progress bar.
 */
export function useEngineAssetStatus(): EngineAssetStatus {
  return useSyncExternalStore(subscribeEngineAssets, () => getEngineAssetsSnapshot().status);
}
