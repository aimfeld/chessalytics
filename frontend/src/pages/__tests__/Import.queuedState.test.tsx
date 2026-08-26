// @vitest-environment jsdom
/**
 * Phase 209 Plan 02 (SURGE-04/D-03) — bare queued label on the import progress row.
 *
 * Verifies:
 * 1. A job with status 'queued' renders the bare "Import queued, starting shortly"
 *    label on the `import-progress-text` test id, with NO queue position number
 *    (a digit-and-hash pattern like "#37") and NO minutes-based ETA wording.
 * 2. A job with status 'in_progress' still renders the existing "Importing ..."
 *    copy, so the new queued branch cannot swallow the old one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
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
});

import { ImportPage } from '../Import';

// Quick 260826-qdl: ImportPage now unconditionally mounts PasteModal, whose
// useSavePastedGame calls the REAL @tanstack/react-query useMutation, which
// internally calls the library's OWN (unmocked) useQueryClient — a module
// mock of the named export does not reach that internal cross-file call, so
// a real QueryClientProvider is required instead of the previous stub.
function renderImport() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TooltipProvider>
          <ImportPage
            onImportStarted={vi.fn()}
            activeJobIds={['job-1']}
            onJobDismissed={vi.fn()}
          />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function baseJob(overrides: Partial<ImportStatusResponse>): ImportStatusResponse {
  return {
    job_id: 'job-1',
    platform: 'chess.com',
    username: 'testuser',
    status: 'in_progress',
    games_fetched: 0,
    games_imported: 0,
    error: null,
    other_importers: 0,
    ...overrides,
  };
}

describe('Import page queued state (SURGE-04/D-03)', () => {
  it('renders a bare queued label with no position number and no ETA', () => {
    pollingState.data = baseJob({ status: 'queued' });

    renderImport();

    const label = screen.getByTestId('import-progress-text');
    expect(label.textContent).toBe('Import queued, starting shortly');
    // D-03 prohibition: no queue position number (a digit-and-hash pattern like
    // "#37") and no minutes-based ETA wording anywhere in the label.
    expect(label.textContent).not.toMatch(/#\d+/);
    expect(label.textContent).not.toMatch(/\bmin(ute)?s?\b/i);
    expect(label.textContent).not.toMatch(/\bETA\b/i);
  });

  it('still renders the existing "Importing ..." copy for an in_progress job', () => {
    pollingState.data = baseJob({
      status: 'in_progress',
      games_fetched: 12,
      games_imported: 5,
    });

    renderImport();

    const label = screen.getByTestId('import-progress-text');
    expect(label.textContent).toBe('Importing testuser (chess.com)... 12 fetched, 5 saved');
  });
});
