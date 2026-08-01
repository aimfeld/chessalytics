// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useWakeLock } from '../useWakeLock';

/**
 * Minimal stand-in for a WakeLockSentinel. Tracks release calls and lets a test
 * fire the browser-initiated 'release' event, which is what actually happens
 * when the document is hidden.
 */
function createSentinel(): {
  sentinel: WakeLockSentinel;
  release: ReturnType<typeof vi.fn>;
  fireRelease: () => void;
} {
  const listeners: Array<() => void> = [];
  const release = vi.fn(() => Promise.resolve());

  const sentinel = {
    released: false,
    type: 'screen' as const,
    release,
    addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onrelease: null,
  } as unknown as WakeLockSentinel;

  return { sentinel, release, fireRelease: () => listeners.forEach((cb) => cb()) };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

/** Lets the hook's in-effect `await navigator.wakeLock.request(...)` settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useWakeLock', () => {
  beforeEach(() => {
    setVisibility('visible');
  });

  afterEach(() => {
    // The hook feature-detects with `'wakeLock' in navigator`, so the property
    // must be gone (not undefined) between tests.
    Reflect.deleteProperty(navigator, 'wakeLock');
    vi.restoreAllMocks();
  });

  function installWakeLock(request: ReturnType<typeof vi.fn>): void {
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
      writable: true,
    });
  }

  it('acquires a screen wake lock on mount', async () => {
    const { sentinel } = createSentinel();
    const request = vi.fn(() => Promise.resolve(sentinel));
    installWakeLock(request);

    renderHook(() => useWakeLock());
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('releases the wake lock on unmount', async () => {
    const { sentinel, release } = createSentinel();
    installWakeLock(vi.fn(() => Promise.resolve(sentinel)));

    const { unmount } = renderHook(() => useWakeLock());
    await flush();
    expect(release).not.toHaveBeenCalled();

    unmount();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('re-acquires after the browser releases the lock and the page becomes visible again', async () => {
    const first = createSentinel();
    const second = createSentinel();
    const request = vi
      .fn()
      .mockResolvedValueOnce(first.sentinel)
      .mockResolvedValueOnce(second.sentinel);
    installWakeLock(request);

    renderHook(() => useWakeLock());
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    // Backgrounding the page: the browser drops the lock itself and fires
    // 'release' on the sentinel.
    act(() => {
      setVisibility('hidden');
      first.fireRelease();
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(request).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not stack locks when the page becomes visible while one is still held', async () => {
    const { sentinel } = createSentinel();
    const request = vi.fn(() => Promise.resolve(sentinel));
    installWakeLock(request);

    renderHook(() => useWakeLock());
    await flush();

    // No intervening 'release' event, so the existing sentinel is still live.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the Wake Lock API is unavailable', async () => {
    expect('wakeLock' in navigator).toBe(false);

    const { unmount } = renderHook(() => useWakeLock());
    await flush();

    expect(() => unmount()).not.toThrow();
  });

  it('swallows a refused request (iOS Low Power Mode)', async () => {
    const request = vi.fn(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    installWakeLock(request);

    const { unmount } = renderHook(() => useWakeLock());
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
    expect(() => unmount()).not.toThrow();
  });
});
