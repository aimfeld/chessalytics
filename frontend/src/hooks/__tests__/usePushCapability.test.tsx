// @vitest-environment jsdom
/**
 * usePushCapability.test.tsx — FLAWCHESS-9P. A malformed 2xx VAPID response
 * body (not the expected `{ application_server_key: string }` shape) must
 * resolve `null` (the existing "push unconfigured" path) rather than letting
 * TanStack Query throw `<queryHash> data is undefined` into the global
 * `QueryCache.onError` Sentry capture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ReactNode } from 'react';

vi.mock('@/lib/push', () => ({
  isPushSupported: () => true,
  readPermission: () => 'default' as NotificationPermission,
}));

// Mock apiClient/pushApi at module level, preserving other exports via importActual
// (mirrors useReadiness.test.tsx / D-12).
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    pushApi: {
      ...actual.pushApi,
      getVapidPublicKey: vi.fn(),
    },
  };
});

import { pushApi } from '@/api/client';
import { usePushCapability } from '../usePushCapability';

function makeAxiosError(status: number, data: unknown): AxiosError {
  const config = { method: 'get', url: '/push/vapid-public-key', headers: new AxiosHeaders() };
  const error = new AxiosError('Request failed with status code ' + status, undefined, config);
  error.response = { status, statusText: '', data, headers: {}, config } as AxiosError['response'];
  return error;
}

function makeWrapper(onErrorSpy: ReturnType<typeof vi.fn>): ({ children }: { children: ReactNode }) => ReactNode {
  return function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      queryCache: new QueryCache({ onError: onErrorSpy }),
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('usePushCapability — VAPID response shape guard (FLAWCHESS-9P)', () => {
  beforeEach(() => {
    vi.mocked(pushApi.getVapidPublicKey).mockReset();
  });

  it('a malformed 2xx body ({}) resolves null / unavailable with no Sentry capture', async () => {
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({} as never);
    const onErrorSpy = vi.fn();

    const { result } = renderHook(() => usePushCapability(), { wrapper: makeWrapper(onErrorSpy) });
    await waitFor(() => expect(result.current.isResolved).toBe(true));

    expect(result.current.vapidPublicKey).toBeNull();
    expect(result.current.available).toBe(false);
    expect(onErrorSpy).not.toHaveBeenCalled();
  });

  it('a malformed 2xx body (empty string) resolves null / unavailable with no Sentry capture', async () => {
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue('' as never);
    const onErrorSpy = vi.fn();

    const { result } = renderHook(() => usePushCapability(), { wrapper: makeWrapper(onErrorSpy) });
    await waitFor(() => expect(result.current.isResolved).toBe(true));

    expect(result.current.vapidPublicKey).toBeNull();
    expect(result.current.available).toBe(false);
    expect(onErrorSpy).not.toHaveBeenCalled();
  });

  it('a 2xx body with an empty application_server_key resolves null / unavailable, no capture', async () => {
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: '' });
    const onErrorSpy = vi.fn();

    const { result } = renderHook(() => usePushCapability(), { wrapper: makeWrapper(onErrorSpy) });
    await waitFor(() => expect(result.current.isResolved).toBe(true));

    expect(result.current.vapidPublicKey).toBeNull();
    expect(result.current.available).toBe(false);
    expect(onErrorSpy).not.toHaveBeenCalled();
  });

  it('happy path: a valid application_server_key resolves and is marked available', async () => {
    vi.mocked(pushApi.getVapidPublicKey).mockResolvedValue({ application_server_key: 'BKxyz' });
    const onErrorSpy = vi.fn();

    const { result } = renderHook(() => usePushCapability(), { wrapper: makeWrapper(onErrorSpy) });
    await waitFor(() => expect(result.current.isResolved).toBe(true));

    expect(result.current.vapidPublicKey).toBe('BKxyz');
    expect(result.current.available).toBe(true);
    expect(onErrorSpy).not.toHaveBeenCalled();
  });

  it('a 404 resolves null / unavailable with no Sentry capture (existing D-12 branch, untouched)', async () => {
    vi.mocked(pushApi.getVapidPublicKey).mockRejectedValue(makeAxiosError(404, { detail: 'not found' }));
    const onErrorSpy = vi.fn();

    const { result } = renderHook(() => usePushCapability(), { wrapper: makeWrapper(onErrorSpy) });
    await waitFor(() => expect(result.current.isResolved).toBe(true));

    expect(result.current.vapidPublicKey).toBeNull();
    expect(result.current.available).toBe(false);
    expect(onErrorSpy).not.toHaveBeenCalled();
  });

  it('a genuine failure (500 AxiosError) still rethrows and reaches the Sentry-standing onError', async () => {
    vi.mocked(pushApi.getVapidPublicKey).mockRejectedValue(makeAxiosError(500, { detail: 'boom' }));
    const onErrorSpy = vi.fn();

    renderHook(() => usePushCapability(), { wrapper: makeWrapper(onErrorSpy) });
    await waitFor(() => expect(onErrorSpy).toHaveBeenCalledTimes(1));
  });

  it('a genuine failure (plain Error) still rethrows and reaches the Sentry-standing onError', async () => {
    vi.mocked(pushApi.getVapidPublicKey).mockRejectedValue(new Error('network down'));
    const onErrorSpy = vi.fn();

    renderHook(() => usePushCapability(), { wrapper: makeWrapper(onErrorSpy) });
    await waitFor(() => expect(onErrorSpy).toHaveBeenCalledTimes(1));
  });
});
