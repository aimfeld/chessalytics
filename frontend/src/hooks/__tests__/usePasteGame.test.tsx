// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock apiClient at module level. Preserve other exports via importActual.
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    apiClient: {
      post: vi.fn(),
    },
  };
});

import { apiClient } from '@/api/client';
import { useSavePastedGame } from '../usePasteGame';

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  return function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useSavePastedGame', () => {
  beforeEach(() => {
    vi.mocked(apiClient.post).mockReset();
  });

  it('POSTs to /imports/paste with the {pgn, user_color} body and returns the parsed response', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: { game_id: 42, created: true, eval_status: 'enqueued' },
    });

    const { result } = renderHook(() => useSavePastedGame(), { wrapper: makeWrapper() });

    result.current.mutate({ pgn: '1. e4 e5 1-0', user_color: 'white' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/imports/paste', {
      pgn: '1. e4 e5 1-0',
      user_color: 'white',
    });
    expect(result.current.data).toEqual({ game_id: 42, created: true, eval_status: 'enqueued' });
  });

  it('surfaces a rejected request as the mutation error state', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error('save failed'));

    const { result } = renderHook(() => useSavePastedGame(), { wrapper: makeWrapper() });

    result.current.mutate({ pgn: '1. e4 e5 1-0', user_color: 'black' });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toEqual(new Error('save failed'));
  });
});
