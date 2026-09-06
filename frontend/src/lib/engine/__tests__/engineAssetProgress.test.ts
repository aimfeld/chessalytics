// @vitest-environment jsdom
/**
 * engineAssetProgress.ts unit tests (Phase 213-01) — covers the T-213-01
 * coercion/clamping/monotonicity contract, the D-11 byte-weighted aggregate
 * (asserted through `useEngineAssets`, so the `useSyncExternalStore` wiring
 * is covered too), and the D-04 `engineGateRequired` gate predicate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  ENGINE_ASSET_FALLBACK_BYTES,
  MAIA_MODEL_BYTES_FALLBACK,
  ORT_RUNTIME_BYTES_FALLBACK,
  STOCKFISH_WASM_BYTES_FALLBACK,
  engineGateRequired,
  getEngineAssetsSnapshot,
  hasSeenEngineAsset,
  markEngineAssetFailed,
  markEngineAssetPending,
  markEngineAssetReady,
  markEngineAssetsRetrying,
  markEngineAssetsUnsupported,
  reportEngineAssetProgress,
  requiredEngineAssets,
  resetEngineAssetForRefetch,
  resetEngineAssetsForTests,
  subscribeEngineAssets,
} from '../engineAssetProgress';
import { useEngineAssets } from '@/hooks/useEngineAssets';

beforeEach(() => {
  resetEngineAssetsForTests();
  localStorage.clear();
});

describe('requiredEngineAssets — G-213-19b referential stability', () => {
  it('returns all three assets, unconditionally (Phase 213-09 adds ort-runtime — G-213-35)', () => {
    expect(requiredEngineAssets()).toEqual(['maia-model', 'stockfish-wasm', 'ort-runtime']);
  });

  it('returns the SAME array reference on every call — the stability the removed useMemo used to provide', () => {
    expect(requiredEngineAssets()).toBe(requiredEngineAssets());
  });
});

describe('reportEngineAssetProgress — coercion (T-213-01)', () => {
  it('falls back to ENGINE_ASSET_FALLBACK_BYTES when total is non-finite (NaN)', () => {
    reportEngineAssetProgress('maia-model', 100, Number.NaN);
    const { result } = renderHook(() => useEngineAssets(['maia-model']));

    expect(Number.isFinite(result.current.percent)).toBe(true);
    expect(result.current.percent).toBeGreaterThanOrEqual(0);
    expect(result.current.percent).toBeLessThanOrEqual(100);
  });

  it('falls back when total is zero', () => {
    reportEngineAssetProgress('maia-model', 100, 0);
    const { result } = renderHook(() => useEngineAssets(['maia-model']));

    expect(Number.isFinite(result.current.percent)).toBe(true);
  });

  it('falls back when total is negative', () => {
    reportEngineAssetProgress('maia-model', 100, -5);
    const { result } = renderHook(() => useEngineAssets(['maia-model']));

    expect(Number.isFinite(result.current.percent)).toBe(true);
  });

  it('never produces Infinity even when both loaded and total are non-finite', () => {
    reportEngineAssetProgress('maia-model', Number.POSITIVE_INFINITY, Number.NaN);
    const { result } = renderHook(() => useEngineAssets(['maia-model']));

    expect(Number.isFinite(result.current.percent)).toBe(true);
    expect(result.current.percent).toBe(100); // clamped to the fallback total
  });
});

describe('reportEngineAssetProgress — clamping + monotonicity', () => {
  it('clamps loaded > total to 100%, never over', () => {
    reportEngineAssetProgress('maia-model', MAIA_MODEL_BYTES_FALLBACK * 2, MAIA_MODEL_BYTES_FALLBACK);
    const { result } = renderHook(() => useEngineAssets(['maia-model']));

    expect(result.current.percent).toBe(100);
  });

  it('keeps loaded monotonic — a later SMALLER report does not move the bar backwards', () => {
    reportEngineAssetProgress('maia-model', 30_000_000, MAIA_MODEL_BYTES_FALLBACK);
    const { result } = renderHook(() => useEngineAssets(['maia-model']));
    const firstPercent = result.current.percent;

    act(() => {
      reportEngineAssetProgress('maia-model', 10_000_000, MAIA_MODEL_BYTES_FALLBACK);
    });

    expect(result.current.percent).toBe(firstPercent);
  });
});

describe('useEngineAssets — byte-weighted aggregate (D-11)', () => {
  it('weights the aggregate by total bytes, NOT a per-asset average', () => {
    // maia-model: 0 / 45,683,686 (untouched — denominator via fallback).
    // stockfish-wasm: fully done (7,295,411 / 7,295,411).
    act(() => {
      markEngineAssetReady('stockfish-wasm');
    });

    const { result } = renderHook(() =>
      useEngineAssets(['maia-model', 'stockfish-wasm'] as const),
    );

    // Byte-weighted: (0 + 7,295,411) / (45,683,686 + 7,295,411) ≈ 13.77% -> 14.
    // A naive per-asset AVERAGE of (0% + 100%) / 2 would wrongly report 50.
    expect(result.current.percent).toBe(14);
    expect(result.current.percent).not.toBe(50);
  });

  it('sanity-checks the fallback constants feeding the ratio above', () => {
    expect(ENGINE_ASSET_FALLBACK_BYTES['maia-model']).toBe(MAIA_MODEL_BYTES_FALLBACK);
    expect(ENGINE_ASSET_FALLBACK_BYTES['stockfish-wasm']).toBe(STOCKFISH_WASM_BYTES_FALLBACK);
  });
});

// ─── Phase 213-09 (G-213-35): ort-runtime as the third gate asset ──────────

describe('useEngineAssets — three-asset denominator (Phase 213-09 adds ort-runtime)', () => {
  it('the denominator is the sum of ALL THREE assets, not just maia-model + stockfish-wasm', () => {
    // maia-model: 0 / 45,683,686 (untouched — denominator via fallback).
    // stockfish-wasm: fully done. ort-runtime: fully done.
    act(() => {
      markEngineAssetReady('stockfish-wasm');
      markEngineAssetReady('ort-runtime');
    });

    const { result } = renderHook(() =>
      useEngineAssets(['maia-model', 'stockfish-wasm', 'ort-runtime'] as const),
    );

    // Byte-weighted (onnxruntime-web 1.29.0 sizes, Phase 217-02):
    // (7,295,411 + 13,961,845) / (45,683,686 + 7,295,411 + 13,961,845) ≈ 31.76% -> 32.
    expect(result.current.percent).toBe(32);
  });

  it('sanity-checks the ort-runtime fallback constant feeding the ratio above', () => {
    expect(ENGINE_ASSET_FALLBACK_BYTES['ort-runtime']).toBe(ORT_RUNTIME_BYTES_FALLBACK);
  });
});

describe('reportEngineAssetProgress — ort-runtime monotonicity across the estimate-to-exact transition', () => {
  it('the percentage never walks backwards when the real Content-Length total replaces the wasm-only fallback estimate', () => {
    // markEngineAssetPending() registers the placeholder total (the SMALLER
    // wasm-only fallback — see ORT_RUNTIME_BYTES_FALLBACK's own doc comment).
    markEngineAssetPending('ort-runtime');
    const { result } = renderHook(() => useEngineAssets(['ort-runtime'] as const));
    expect(result.current.percent).toBe(0); // no bytes reported yet, either way

    // The FIRST real chunk arrives with the ACTUAL (larger, asyncify-build)
    // Content-Length — this is "the exact figure lands before the bar leaves
    // zero": total corrects upward in the SAME call that first reports any
    // loaded bytes, so percent only ever moves forward from here.
    const ASYNCIFY_TOTAL = 25_749_873; // onnxruntime-web 1.29.0 (Phase 217-02)
    act(() => {
      reportEngineAssetProgress('ort-runtime', 1_000_000, ASYNCIFY_TOTAL);
    });
    const afterFirstChunk = result.current.percent;
    expect(afterFirstChunk).toBeGreaterThan(0);

    // Every subsequent chunk keeps reporting the SAME (now-accurate) total —
    // percent must keep climbing, never drop back down.
    act(() => {
      reportEngineAssetProgress('ort-runtime', 5_000_000, ASYNCIFY_TOTAL);
    });
    expect(result.current.percent).toBeGreaterThanOrEqual(afterFirstChunk);
  });
});

describe("resetEngineAssetForRefetch('ort-runtime') — the webgpu->wasm respawn's different binary", () => {
  it('resets ort-runtime loaded to 0 and done to false, preserving total and leaving status untouched', () => {
    markEngineAssetReady('ort-runtime'); // status -> 'ready' (only asset touched)

    resetEngineAssetForRefetch('ort-runtime');

    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.assets['ort-runtime']).toEqual({
      loaded: 0,
      total: ORT_RUNTIME_BYTES_FALLBACK,
      done: false,
    });
    expect(snapshot.status).toBe('ready');
  });

  it('useEngineAssets reports ort-runtime as NOT ready during the silent in-flight re-fetch window', () => {
    markEngineAssetReady('ort-runtime');

    resetEngineAssetForRefetch('ort-runtime');

    const { result } = renderHook(() => useEngineAssets(['ort-runtime'] as const));
    expect(result.current.ready).toBe(false);
  });
});

describe('markEngineAssetPending / markEngineAssetReady — CR-02: allDone must not fire on a still-downloading concurrently-spawned asset', () => {
  it('does not flip status to ready when a concurrently-armed asset has not reported progress yet', () => {
    // Mirrors workerPool.ts::ensureSpawned() and maiaWorkerHost.ts::spawn()
    // both firing synchronously from the same provider bring-up effect,
    // BEFORE either asset's first async progress/ready message arrives.
    markEngineAssetPending('maia-model');
    markEngineAssetPending('stockfish-wasm');

    // Stockfish (much smaller) starts downloading and finishes — Maia has not
    // posted even one progress event yet, so it is still `done: false`.
    reportEngineAssetProgress('stockfish-wasm', 1_000_000, STOCKFISH_WASM_BYTES_FALLBACK);
    markEngineAssetReady('stockfish-wasm');

    const { result } = renderHook(() =>
      useEngineAssets(['maia-model', 'stockfish-wasm'] as const),
    );
    expect(result.current.status).toBe('downloading');
    expect(result.current.ready).toBe(false);
  });

  it('flips status to ready once the armed-but-slower asset also completes', () => {
    markEngineAssetPending('maia-model');
    markEngineAssetPending('stockfish-wasm');
    markEngineAssetReady('stockfish-wasm');

    markEngineAssetReady('maia-model');

    const { result } = renderHook(() =>
      useEngineAssets(['maia-model', 'stockfish-wasm'] as const),
    );
    expect(result.current.status).toBe('ready');
  });

  it('store-level property only, not reachable under G-213-19b: an asset that was never registered does not hold allDone back', () => {
    markEngineAssetPending('maia-model');
    markEngineAssetReady('maia-model');

    const { result } = renderHook(() => useEngineAssets(['maia-model'] as const));
    expect(result.current.status).toBe('ready');
  });
});

describe('engineGateRequired — G-213-19b unconditional bundle (no per-persona subset)', () => {
  it('is true on a clean localStorage', () => {
    expect(engineGateRequired()).toBe(true);
  });

  it('is still true once only maia-model is seen', () => {
    markEngineAssetReady('maia-model');
    expect(engineGateRequired()).toBe(true);
  });

  it('is true on a clean localStorage (all three assets required, none seen)', () => {
    expect(engineGateRequired()).toBe(true);
  });

  it('becomes false once ALL THREE assets have been marked ready — no timer, no elapsed-wait', () => {
    markEngineAssetReady('maia-model');
    markEngineAssetReady('stockfish-wasm');
    markEngineAssetReady('ort-runtime');
    expect(engineGateRequired()).toBe(false);
  });

  it('stays true when only TWO of the three assets have been seen — a partially-cached device is still gated (Phase 213-09)', () => {
    markEngineAssetReady('maia-model');
    markEngineAssetReady('stockfish-wasm'); // ort-runtime never marked
    expect(engineGateRequired()).toBe(true);
  });

  it('stays true when only ONE of the three assets has been seen — a partially-cached device is still gated', () => {
    markEngineAssetReady('maia-model'); // stockfish-wasm, ort-runtime never marked
    expect(engineGateRequired()).toBe(true);
  });

  it('stays true when only stockfish-wasm (not maia-model, not ort-runtime) has been seen', () => {
    markEngineAssetReady('stockfish-wasm');
    expect(engineGateRequired()).toBe(true);
  });

  it('stays true when only ort-runtime has been seen — the new asset alone does not satisfy the gate', () => {
    markEngineAssetReady('ort-runtime');
    expect(engineGateRequired()).toBe(true);
  });
});

describe('markEngineAssetFailed — Plan 04 owns this UI; Task 1 owns the transport', () => {
  it('sets status to failed without discarding the prior progress on that asset', () => {
    reportEngineAssetProgress('maia-model', 20_000_000, MAIA_MODEL_BYTES_FALLBACK);

    markEngineAssetFailed('maia-model');

    const { result } = renderHook(() => useEngineAssets(['maia-model']));
    expect(result.current.status).toBe('failed');
  });

  // ─── Quick 260829-tku: failureKind transport ──────────────────────────────

  it('called WITH a kind records that kind on the snapshot alongside status:failed, without disturbing prior byte progress', () => {
    reportEngineAssetProgress('maia-model', 20_000_000, MAIA_MODEL_BYTES_FALLBACK);

    markEngineAssetFailed('maia-model', 'oom');

    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.failureKind).toBe('oom');
    expect(snapshot.assets['maia-model']?.loaded).toBe(20_000_000);
  });

  it('called WITHOUT a kind leaves the recorded kind null — the Stockfish pool and useStockfishEngine call sites rely on this', () => {
    markEngineAssetFailed('maia-model');

    expect(getEngineAssetsSnapshot().failureKind).toBeNull();
  });

  it('a classified failure followed by an unclassified one on a DIFFERENT asset keeps the classification', () => {
    markEngineAssetFailed('maia-model', 'oom');
    markEngineAssetFailed('stockfish-wasm');

    expect(getEngineAssetsSnapshot().failureKind).toBe('oom');
  });
});

describe('markEngineAssetsRetrying — D-15 manual retry seam', () => {
  it('clears a failed status back to idle, leaves an already-done asset (and every seen flag) untouched', () => {
    reportEngineAssetProgress('maia-model', 20_000_000, MAIA_MODEL_BYTES_FALLBACK);
    markEngineAssetFailed('maia-model');
    markEngineAssetReady('stockfish-wasm'); // writes stockfish-wasm's seen flag

    markEngineAssetsRetrying();

    const { result } = renderHook(() => useEngineAssets(['maia-model', 'stockfish-wasm'] as const));
    expect(result.current.status).toBe('idle');
    // The completed asset is left completely untouched.
    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']).toEqual({
      loaded: STOCKFISH_WASM_BYTES_FALLBACK,
      total: STOCKFISH_WASM_BYTES_FALLBACK,
      done: true,
    });
    expect(hasSeenEngineAsset('stockfish-wasm')).toBe(true);
  });

  it("WR-01: resets the failed (not-done) asset's loaded byte count to 0, so a fresh worker is not clamped up to the old high-water mark", () => {
    reportEngineAssetProgress('maia-model', 20_000_000, MAIA_MODEL_BYTES_FALLBACK);
    markEngineAssetFailed('maia-model');

    markEngineAssetsRetrying();

    expect(getEngineAssetsSnapshot().assets['maia-model']).toEqual({
      loaded: 0,
      total: MAIA_MODEL_BYTES_FALLBACK,
      done: false,
    });
  });

  it('clears a classified failure kind back to null, while the existing status/byte/seen-flag assertions in this describe still hold', () => {
    reportEngineAssetProgress('maia-model', 20_000_000, MAIA_MODEL_BYTES_FALLBACK);
    markEngineAssetFailed('maia-model', 'oom');

    markEngineAssetsRetrying();

    expect(getEngineAssetsSnapshot().failureKind).toBeNull();
  });

  it("WR-01: a fresh worker's first near-zero progress report is not clamped up to the failed attempt's old high-water mark", () => {
    // Failed attempt had already downloaded ~87% (40 of 45.7 MB) before dying.
    reportEngineAssetProgress('maia-model', 40_000_000, MAIA_MODEL_BYTES_FALLBACK);
    markEngineAssetFailed('maia-model');
    markEngineAssetsRetrying();

    // The re-triggered worker's very first progress message, re-fetching the
    // whole asset from scratch.
    reportEngineAssetProgress('maia-model', 100, MAIA_MODEL_BYTES_FALLBACK);

    const { result } = renderHook(() => useEngineAssets(['maia-model']));
    // Without the fix, `reportEngineAssetProgress`'s monotonic clamp would
    // report max(40_000_000, 100) here — ~87%, not the fresh worker's real,
    // near-zero progress.
    expect(result.current.percent).toBeLessThan(5);
  });
});

describe('resetEngineAssetForRefetch — WR-02: mid-session self-heal must not report a stale ready signal', () => {
  it('resets loaded to 0 and done to false, preserving total and leaving status untouched', () => {
    markEngineAssetReady('maia-model'); // status -> 'ready' (only asset touched)

    resetEngineAssetForRefetch('maia-model');

    const snapshot = getEngineAssetsSnapshot();
    expect(snapshot.assets['maia-model']).toEqual({
      loaded: 0,
      total: MAIA_MODEL_BYTES_FALLBACK,
      done: false,
    });
    // Deliberately NOT reverted — see the function's doc comment: a
    // WebGPU->wasm respawn is not a user-facing failure and must not
    // resurface a gate the user already passed.
    expect(snapshot.status).toBe('ready');
  });

  it('useEngineAssets reports the asset as NOT ready during the silent in-flight re-fetch window', () => {
    markEngineAssetReady('maia-model');

    resetEngineAssetForRefetch('maia-model');

    const { result } = renderHook(() => useEngineAssets(['maia-model']));
    expect(result.current.ready).toBe(false);
  });
});

describe('hasSeenEngineAsset — Safari private mode', () => {
  const originalGetItem = Storage.prototype.getItem;

  afterEach(() => {
    Storage.prototype.getItem = originalGetItem;
  });

  it('returns false rather than throwing when localStorage.getItem throws', () => {
    Storage.prototype.getItem = () => {
      throw new Error('SecurityError: localStorage disabled');
    };

    expect(() => hasSeenEngineAsset('maia-model')).not.toThrow();
    expect(hasSeenEngineAsset('maia-model')).toBe(false);
  });
});

// ─── Phase 213-10 (G-213-35 third part): coalesced store notifications ─────

describe('reportEngineAssetProgress — coalesced notifications (G-213-35)', () => {
  it('a listener spy receives ONE notification across many sub-one-percent progress calls, and the snapshot still reports the exact latest byte count throughout', () => {
    const total = 1_000_000;
    // idle -> downloading transition; establishes a baseline at 0%.
    reportEngineAssetProgress('maia-model', 0, total);

    const listener = vi.fn();
    const unsubscribe = subscribeEngineAssets(listener);

    // Many tiny increments, all rounding to the same 0% — none should cross
    // a percent boundary.
    for (let loaded = 100; loaded < 5_000; loaded += 100) {
      reportEngineAssetProgress('maia-model', loaded, total);
      // The snapshot must reflect the LATEST bytes immediately, even though
      // no listener has been notified — coalescing defers the notification
      // only, never the state.
      expect(getEngineAssetsSnapshot().assets['maia-model']?.loaded).toBe(loaded);
    }

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('crossing a rounded percent boundary notifies', () => {
    const total = 1_000_000;
    reportEngineAssetProgress('maia-model', 0, total);

    const listener = vi.fn();
    const unsubscribe = subscribeEngineAssets(listener);

    reportEngineAssetProgress('maia-model', 4_000, total); // 0.4% -> rounds to 0%, no boundary crossed
    expect(listener).not.toHaveBeenCalled();

    reportEngineAssetProgress('maia-model', 15_000, total); // 1.5% -> rounds to 2%, boundary crossed
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('markEngineAssetPending notifies even when nothing else has changed (CR-02)', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEngineAssets(listener);

    markEngineAssetPending('maia-model');

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('ready/failed/unsupported/retrying/refetch each notify unconditionally and synchronously', () => {
    markEngineAssetPending('maia-model');

    let listener = vi.fn();
    let unsubscribe = subscribeEngineAssets(listener);
    markEngineAssetReady('maia-model');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();

    listener = vi.fn();
    unsubscribe = subscribeEngineAssets(listener);
    markEngineAssetFailed('maia-model');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();

    listener = vi.fn();
    unsubscribe = subscribeEngineAssets(listener);
    markEngineAssetsUnsupported('no-wasm-simd');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();

    listener = vi.fn();
    unsubscribe = subscribeEngineAssets(listener);
    markEngineAssetsRetrying();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();

    listener = vi.fn();
    unsubscribe = subscribeEngineAssets(listener);
    resetEngineAssetForRefetch('maia-model');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a refetch's first progress report notifies rather than being swallowed as 'unchanged'", () => {
    // Get the asset to a rounded 50% before marking ready — this is the
    // percent the pre-refetch pass was last notified at.
    reportEngineAssetProgress('maia-model', 500_000, 1_000_000);
    markEngineAssetReady('maia-model');

    resetEngineAssetForRefetch('maia-model');

    const listener = vi.fn();
    const unsubscribe = subscribeEngineAssets(listener);

    // The new pass's first progress report happens to round to the SAME 50%
    // the OLD pass was last notified at — without clearing the remembered
    // percent on refetch, this would be wrongly swallowed as "unchanged".
    reportEngineAssetProgress('maia-model', 500_000, 1_000_000);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('the 0-to-100 sweep of one asset produces at most 101 notifications total, bounded by percent rather than chunk count', () => {
    const total = MAIA_MODEL_BYTES_FALLBACK;
    const listener = vi.fn();
    const unsubscribe = subscribeEngineAssets(listener);

    const STREAM_CHUNK_SIZE = 16_384; // realistic small stream chunk
    for (let loaded = STREAM_CHUNK_SIZE; loaded < total; loaded += STREAM_CHUNK_SIZE) {
      reportEngineAssetProgress('maia-model', loaded, total);
    }
    reportEngineAssetProgress('maia-model', total, total);

    const MAX_NOTIFICATIONS = 101; // 0..100 inclusive
    expect(listener.mock.calls.length).toBeLessThanOrEqual(MAX_NOTIFICATIONS);
    unsubscribe();
  });
});

// ─── Hotfix 2026-09-06 (SEED-158): unsupportedReason ─────────────────────────

describe('unsupportedReason', () => {
  beforeEach(() => {
    resetEngineAssetsForTests();
  });

  it('is null until a gate fires, records the reason with the unsupported status, and resets to null', () => {
    expect(getEngineAssetsSnapshot().unsupportedReason).toBeNull();

    markEngineAssetsUnsupported('ios-webkit');
    expect(getEngineAssetsSnapshot().status).toBe('unsupported');
    expect(getEngineAssetsSnapshot().unsupportedReason).toBe('ios-webkit');

    resetEngineAssetsForTests();
    expect(getEngineAssetsSnapshot().unsupportedReason).toBeNull();
  });

  it('is exposed on the useEngineAssets snapshot shape (referential stability preserved between reads)', () => {
    markEngineAssetsUnsupported('no-wasm-simd');
    const first = getEngineAssetsSnapshot();
    const second = getEngineAssetsSnapshot();
    expect(first).toBe(second);
    expect(first.unsupportedReason).toBe('no-wasm-simd');
  });
});

// ─── Hotfix 2026-09-06 (SEED-158 follow-up): unsupported is sticky ───────────

describe('unsupported status survives other assets\' traffic', () => {
  beforeEach(() => {
    resetEngineAssetsForTests();
  });

  // Prod repro (Chrome on iPhone, /analysis): the Maia gate marks the store
  // unsupported without ever registering maia-model/ort-runtime; Stockfish
  // then downloads normally. Every one of its store calls must leave the
  // terminal status alone, or the analysis gate un-suppresses and sits at
  // the Stockfish share (~11%) forever.
  it('a Stockfish progress report does NOT flip unsupported to downloading', () => {
    markEngineAssetsUnsupported('ios-webkit');
    markEngineAssetPending('stockfish-wasm');
    reportEngineAssetProgress('stockfish-wasm', 1_000_000, STOCKFISH_WASM_BYTES_FALLBACK);

    expect(getEngineAssetsSnapshot().status).toBe('unsupported');
    expect(getEngineAssetsSnapshot().unsupportedReason).toBe('ios-webkit');
  });

  it('a Stockfish ready (the only registered asset) does NOT flip unsupported to ready', () => {
    markEngineAssetsUnsupported('ios-webkit');
    markEngineAssetPending('stockfish-wasm');
    markEngineAssetReady('stockfish-wasm');

    expect(getEngineAssetsSnapshot().status).toBe('unsupported');
    // The asset itself is still recorded as done — only the aggregate status is protected.
    expect(getEngineAssetsSnapshot().assets['stockfish-wasm']?.done).toBe(true);
  });

  it('a Stockfish failure does NOT downgrade unsupported to failed (Retry could never help)', () => {
    markEngineAssetsUnsupported('no-wasm-simd');
    markEngineAssetFailed('stockfish-wasm');

    expect(getEngineAssetsSnapshot().status).toBe('unsupported');
  });

  it('the same calls without a prior unsupported still drive downloading -> ready (guard is not always-on)', () => {
    markEngineAssetPending('stockfish-wasm');
    reportEngineAssetProgress('stockfish-wasm', 1_000_000, STOCKFISH_WASM_BYTES_FALLBACK);
    expect(getEngineAssetsSnapshot().status).toBe('downloading');
    markEngineAssetReady('stockfish-wasm');
    expect(getEngineAssetsSnapshot().status).toBe('ready');
  });
});
