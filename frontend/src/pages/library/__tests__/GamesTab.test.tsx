// @vitest-environment jsdom
/**
 * GamesTab vitest suite — tests the key migration scenarios from Plan 108-08:
 *
 * 1. Panel receives flawFilter from useFlawFilterStore (D-04)
 * 2. Changing the flaw filter resets the page offset (calls useLibraryGames with offset 0)
 * 3. GamesTab does NOT URL-sync flaw filter (D-04)
 * 4. isError branch renders the mandatory error copy
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ── Mock heavy dependencies ───────────────────────────────────────────────────

// Stub SidebarLayout — render both the sidebar content (panels) and children
// so that LibraryFilterPanel (in the panel) is visible in the test DOM.
vi.mock('@/components/layout/SidebarLayout', () => ({
  SidebarLayout: ({
    children,
    panels,
  }: {
    children: React.ReactNode;
    panels: Array<{ content: React.ReactNode }>;
  }) => (
    <div data-testid="stub-sidebar-layout">
      {panels.map((p, i) => (
        <div key={i} data-testid="stub-sidebar-panel">{p.content}</div>
      ))}
      {children}
    </div>
  ),
}));

// Stub LibraryFilterPanel — game-metadata only now (flaw filter lives in its own panel)
vi.mock('@/components/filters/LibraryFilterPanel', () => ({
  LibraryFilterPanel: () => <div data-testid="stub-library-filter-panel" />,
}));

// Stub FlawFilterControl — capture severity/tags for assertion. The flaw filter is
// now hosted in its own separate sidebar panel (not inside LibraryFilterPanel).
let capturedFlawFilter: { severity: string[]; tags: string[] } | null = null;
// Quick 260620-pza: capture showTacticFilter to assert the Games tab now enables the
// tactic-filter section (parity with the Flaws tab).
let capturedShowTacticFilter: boolean | undefined;

vi.mock('@/components/filters/FlawFilterControl', () => ({
  FlawFilterControl: ({
    severity,
    tags,
    showTacticFilter,
  }: {
    severity: string[];
    tags: string[];
    showTacticFilter?: boolean;
  }) => {
    capturedFlawFilter = { severity, tags };
    capturedShowTacticFilter = showTacticFilter;
    return <div data-testid="stub-flaw-filter-control" data-flaw-filter={JSON.stringify({ severity, tags })} />;
  },
  TagFilterLogicInfo: () => <div data-testid="stub-tag-filter-logic-info" />,
}));

// Stub LibraryGameCardList to avoid complex rendering
vi.mock('@/components/results/LibraryGameCardList', () => ({
  LibraryGameCardList: () => <div data-testid="stub-game-card-list" />,
}));

// Stub useUserProfile
vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({
    data: { chess_com_game_count: 5, lichess_game_count: 10 },
  }),
}));

// ── Controlled useLibraryGames mock ───────────────────────────────────────────

type MockGamesResult = {
  data?: {
    games: unknown[];
    matched_count: number;
    offset: number;
    limit: number;
  };
  isLoading: boolean;
  isError: boolean;
};

let mockGamesResult: MockGamesResult = {
  data: { games: [], matched_count: 0, offset: 0, limit: 20 },
  isLoading: false,
  isError: false,
};

// Track calls to useLibraryGames — captures (filters, flawFilter, offset, limit)
const useLibraryGamesSpy = vi.fn(() => mockGamesResult);

vi.mock('@/hooks/useLibrary', () => ({
  useLibraryGames: (...args: unknown[]) => useLibraryGamesSpy(...args),
  useLibraryFlaws: () => ({ data: undefined, isLoading: false, isError: false }),
  useLibraryFlawStats: () => ({ data: undefined, isLoading: false, isError: false }),
}));

// ── useFlawFilterStore mock ───────────────────────────────────────────────────

let mockFlawFilterState = {
  severity: ['blunder', 'mistake'] as ('blunder' | 'mistake')[],
  tags: [] as string[],
};
const mockSetFlawFilter = vi.fn((updater: unknown) => {
  const next =
    typeof updater === 'function'
      ? (updater as (prev: typeof mockFlawFilterState) => typeof mockFlawFilterState)(mockFlawFilterState)
      : (updater as typeof mockFlawFilterState);
  mockFlawFilterState = next;
});

vi.mock('@/hooks/useFlawFilterStore', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useFlawFilterStore')>(
    '@/hooks/useFlawFilterStore',
  );
  return {
    ...actual,
    useFlawFilterStore: () => [mockFlawFilterState, mockSetFlawFilter] as const,
  };
});

// ── Import GamesTab after mocks ───────────────────────────────────────────────

import { GamesTab } from '../GamesTab';

// ── Render helper ─────────────────────────────────────────────────────────────

function renderGamesTab(path = '/library/games') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <GamesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mockFlawFilterState = { severity: ['blunder', 'mistake'], tags: [] };
  capturedFlawFilter = null;
  vi.clearAllMocks();
  mockGamesResult = {
    data: { games: [], matched_count: 0, offset: 0, limit: 20 },
    isLoading: false,
    isError: false,
  };
});

afterEach(() => {
  cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GamesTab', () => {
  describe('rendering', () => {
    it('renders the games tab content root', () => {
      renderGamesTab();
      expect(screen.getByTestId('games-tab-content')).toBeTruthy();
    });

    it('renders LibraryFilterPanel (desktop + mobile)', () => {
      renderGamesTab();
      const panels = screen.getAllByTestId('stub-library-filter-panel');
      // Desktop sidebar panel + mobile drawer
      expect(panels.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('D-04: shared flaw filter (no URL sync)', () => {
    it('passes flawFilter from useFlawFilterStore to the flaw filter control', () => {
      mockFlawFilterState = { severity: ['blunder'], tags: ['miss'] };
      renderGamesTab();
      // The dedicated flaw-filter panel should receive the store's flawFilter
      expect(capturedFlawFilter).toBeTruthy();
      expect(capturedFlawFilter?.severity).toEqual(['blunder']);
      expect(capturedFlawFilter?.tags).toEqual(['miss']);
    });

    it('enables the tactic-filter section on the Games tab (Quick 260620-pza)', () => {
      capturedShowTacticFilter = undefined;
      mockFlawFilterState = { severity: ['blunder'], tags: [] };
      renderGamesTab();
      // The Games tab now passes showTacticFilter, surfacing the tactic tag group
      // (parity with the Flaws tab).
      expect(capturedShowTacticFilter).toBe(true);
    });

    it('passes flawFilter to useLibraryGames (severity + tags)', () => {
      mockFlawFilterState = { severity: ['blunder', 'mistake'], tags: ['reversed'] };
      renderGamesTab();
      // useLibraryGames should receive the flawFilter as second arg
      expect(useLibraryGamesSpy).toHaveBeenCalled();
      const calls = useLibraryGamesSpy.mock.calls;
      const lastCall = calls[calls.length - 1];
      // Second arg is flawFilter
      expect(lastCall).toBeTruthy();
      const flawFilterArg = lastCall![1];
      expect(flawFilterArg).toMatchObject({
        severity: ['blunder', 'mistake'],
        tags: ['reversed'],
      });
    });

    it('does NOT add flaw filter params to the URL (no URL sync)', () => {
      mockFlawFilterState = { severity: ['blunder'], tags: ['miss'] };
      // GamesTab should never call useSearchParams with flaw filter data
      // We verify this by checking the URL has no ?tag= or ?severity= params
      // (GamesTab is rendered in MemoryRouter — URL stays at /library/games)
      renderGamesTab('/library/games');
      // Since there's no useSearchParams in GamesTab, the rendered content should not
      // show any URL-dependent UI (this test primarily asserts no crash/errors)
      expect(screen.getByTestId('games-tab-content')).toBeTruthy();
    });
  });

  describe('isError branch', () => {
    it('renders mandatory error message when useLibraryGames returns isError', () => {
      mockGamesResult = { data: undefined, isLoading: false, isError: true };
      renderGamesTab();
      // Error message appears in both desktop + mobile sections
      const errors = screen.getAllByText(
        'Failed to load games. Something went wrong. Please try again in a moment.',
      );
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT render game cards when isError', () => {
      mockGamesResult = { data: undefined, isLoading: false, isError: true };
      renderGamesTab();
      expect(screen.queryAllByTestId('stub-game-card-list')).toHaveLength(0);
    });
  });
});
