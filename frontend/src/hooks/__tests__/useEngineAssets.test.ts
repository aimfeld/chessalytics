// @vitest-environment jsdom
/**
 * useEngineAssets.ts unit tests — Phase 213-10 (G-213-35 third part): the
 * narrow `useEngineAssetStatus()` companion hook.
 *
 * The pre-existing `useEngineAssets` byte-weighted aggregate is covered by
 * `engineAssetProgress.test.ts` (it imports `useEngineAssets` directly to
 * exercise the store's `useSyncExternalStore` wiring). This file is
 * dedicated to the new narrow hook and its render-count contract.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEngineAssetStatus } from '../useEngineAssets';
import {
  MAIA_MODEL_BYTES_FALLBACK,
  markEngineAssetPending,
  markEngineAssetReady,
  reportEngineAssetProgress,
  resetEngineAssetsForTests,
} from '@/lib/engine/engineAssetProgress';

beforeEach(() => {
  resetEngineAssetsForTests();
  localStorage.clear();
});

describe('useEngineAssetStatus', () => {
  it('returns the current status', () => {
    const { result } = renderHook(() => useEngineAssetStatus());
    expect(result.current).toBe('idle');
  });

  it('reflects a status transition', () => {
    const { result } = renderHook(() => useEngineAssetStatus());

    act(() => {
      markEngineAssetPending('maia-model');
      reportEngineAssetProgress('maia-model', 100, MAIA_MODEL_BYTES_FALLBACK);
    });

    expect(result.current).toBe('downloading');
  });

  it('does NOT re-render on a byte-only progress report, but DOES re-render on a status transition (render count, not merely the returned value — G-213-35)', () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useEngineAssetStatus();
    });
    expect(renderCount).toBe(1);

    // idle -> downloading is a genuine status transition — must re-render.
    act(() => {
      markEngineAssetPending('maia-model');
      reportEngineAssetProgress('maia-model', 1, MAIA_MODEL_BYTES_FALLBACK);
    });
    expect(result.current).toBe('downloading');
    expect(renderCount).toBeGreaterThan(1);
    const afterTransition = renderCount;

    // A byte-only progress report (status stays 'downloading') must NOT
    // trigger a re-render — this is the whole point of returning a
    // primitive: useSyncExternalStore bails via Object.is.
    act(() => {
      reportEngineAssetProgress('maia-model', 2_000_000, MAIA_MODEL_BYTES_FALLBACK);
    });
    expect(renderCount).toBe(afterTransition);

    // Reaching ready (only asset registered) is another genuine transition —
    // must re-render again.
    act(() => {
      markEngineAssetReady('maia-model');
    });
    expect(result.current).toBe('ready');
    expect(renderCount).toBeGreaterThan(afterTransition);
  });
});
