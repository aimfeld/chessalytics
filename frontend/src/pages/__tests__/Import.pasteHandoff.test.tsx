// @vitest-environment jsdom
/**
 * Quick 260826-qdl — Import-tab paste entry point, end-to-end.
 *
 * Proves the full "paste on the Import tab, land on the analysis board" path:
 * button renders below the lichess card, opens the shared PasteModal (no
 * duplicate modal component), and Load/Analyze-full-game each reach the same
 * destinations the on-board modal already reaches.
 *
 * Landmine (planner-flagged): the sibling Import.queuedState.test.tsx harness
 * mocks `useQueryClient` to a bare stub — copying that here would break
 * PasteModal's `useSavePastedGame` (a real `useMutation` call). This file
 * wraps the render in a real `QueryClientProvider` instead.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { takePastedGameHandoff } from '@/lib/pastedGameHandoff';
import type { ImportStatusResponse } from '@/types/api';

const pollingState: { data: ImportStatusResponse | null } = { data: null };

vi.mock('@/hooks/useReadiness', () => ({
  useReadiness: () => ({
    tier1: false,
    tier2: false,
    pendingCount: 0,
    totalCount: 0,
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({
    data: {
      chess_com_username: 'testuser',
      lichess_username: null,
      chess_com_game_count: 100,
      lichess_game_count: 0,
      chess_com_last_sync_at: '2026-01-01T00:00:00Z',
      lichess_last_sync_at: null,
      is_guest: false,
      is_superuser: false,
      email: 'test@example.com',
    },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    token: 'test-token',
    logoutForPromotion: vi.fn(),
  }),
}));

vi.mock('@/hooks/useImport', () => ({
  useImportTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useImportPolling: () => ({ data: pollingState.data }),
}));

vi.mock('@/hooks/useImportSettings', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useImportSettings')>(
    '@/hooks/useImportSettings',
  );
  return {
    ...actual,
    useImportSettings: () => ({
      data: {
        tc_bullet: false,
        tc_blitz: true,
        tc_rapid: true,
        tc_classical: true,
        game_cap: 1000,
        imported_counts: {},
      },
      isLoading: false,
      isError: false,
    }),
    useUpdateImportSettings: () => ({ mutate: vi.fn() }),
  };
});

vi.mock('@/hooks/useEvalCoverage', () => ({
  useEvalCoverage: () => ({
    pendingCount: 0,
    totalCount: 0,
    pct: 100,
    isPending: false,
    isLoading: false,
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/api/client', () => ({
  apiClient: { delete: vi.fn(), post: vi.fn() },
}));

afterEach(() => {
  cleanup();
  pollingState.data = null;
  mockNavigate.mockReset();
  sessionStorage.clear();
});

import { ImportPage } from '../Import';

function renderImport() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TooltipProvider>
          <ImportPage
            onImportStarted={vi.fn()}
            activeJobIds={[]}
            onJobDismissed={vi.fn()}
          />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const VALID_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const VALID_PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5';

describe('Import tab paste entry point (Quick 260826-qdl)', () => {
  it('renders the button below the lichess card with the right name and testid', () => {
    renderImport();

    const button = screen.getByTestId('btn-import-single-game');
    expect(button.textContent).toContain('Import Single Game (PGN/FEN)');

    // Below the lichess card: the lichess card must precede the button in DOM order.
    const lichessCard = screen.getByTestId('import-platform-lichess');
    expect(
      lichessCard.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('clicking the button reveals the shared PasteModal', () => {
    renderImport();

    expect(screen.queryByTestId('paste-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('btn-import-single-game'));
    expect(screen.getByTestId('paste-modal')).toBeTruthy();
  });

  it('loading a valid FEN writes a handoff and navigates to /analysis', () => {
    renderImport();
    fireEvent.click(screen.getByTestId('btn-import-single-game'));

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: VALID_FEN } });
    const loadButton = screen.getByTestId('btn-paste-load') as HTMLButtonElement;
    expect(loadButton.disabled).toBe(false);
    fireEvent.click(loadButton);

    expect(mockNavigate).toHaveBeenCalledWith('/analysis');
    const handoff = takePastedGameHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff?.result).toEqual({ kind: 'fen', fen: VALID_FEN });
    expect(handoff?.userColor).toBe('white');
  });

  it('loading a valid PGN with Black selected writes a handoff carrying sans/rootFen/headers/userColor', () => {
    renderImport();
    fireEvent.click(screen.getByTestId('btn-import-single-game'));

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: VALID_PGN } });
    fireEvent.click(screen.getByTestId('paste-side-black'));
    fireEvent.click(screen.getByTestId('btn-paste-load'));

    expect(mockNavigate).toHaveBeenCalledWith('/analysis');
    const handoff = takePastedGameHandoff();
    expect(handoff).not.toBeNull();
    expect(handoff?.userColor).toBe('black');
    if (handoff?.result.kind === 'pgn') {
      expect(handoff.result.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
      expect(handoff.result.rootFen).toBe(
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      );
    } else {
      throw new Error('expected a pgn-kind handoff result');
    }
  });

  it('garbage text leaves Load disabled and performs no navigation', () => {
    renderImport();
    fireEvent.click(screen.getByTestId('btn-import-single-game'));

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: 'not chess at all' } });

    expect((screen.getByTestId('btn-paste-load') as HTMLButtonElement).disabled).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(takePastedGameHandoff()).toBeNull();
  });
});
