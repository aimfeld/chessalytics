// @vitest-environment jsdom
/**
 * FlawsTab vitest suite — tests the three key scenarios from Plan 108-07:
 *
 * 1. Deep-link (?tag=reversed) pre-populates the flaw filter control
 * 2. isError branch renders the mandatory error copy
 * 3. Flaw list renders rows from mocked useLibraryFlaws
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Mock } from 'vitest';

// Stub ResizeObserver — required by Radix UI ToggleGroup (added Phase 129 TACUI-06).
// [Rule 1 - Bug] FlawFilterControl now renders ToggleGroup (via showTacticFilter);
// the Radix use-size hook calls ResizeObserver which jsdom doesn't provide.
beforeAll(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    };
  }
});

// ── Mock heavy dependencies ───────────────────────────────────────────────────

// Stub LazyMiniBoard to avoid IntersectionObserver + react-chessboard in jsdom
vi.mock('@/components/board/LazyMiniBoard', () => ({
  LazyMiniBoard: ({ fen }: { fen: string }) => (
    <div data-testid="stub-mini-board" data-fen={fen} />
  ),
}));

// Stub SidebarLayout — render both the sidebar content (panels) and children
// so that FlawFilterControl (in the panel) is visible in the test DOM.
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
        // Render all panel contents so filter controls are accessible
        <div key={i} data-testid="stub-sidebar-panel">{p.content}</div>
      ))}
      {children}
    </div>
  ),
}));

// Stub TagChip and TagLegend to avoid Popover/portal issues in jsdom.
// TagLegend is also used by FlawCard (rendered via the grid in this tab).
vi.mock('@/components/library/TagChip', () => ({
  TagChip: ({ tag }: { tag: string }) => (
    <span data-testid={`stub-tag-chip-${tag}`}>{tag}</span>
  ),
  TagLegend: () => null,
}));

// Stub LibraryFilterPanel to avoid window.matchMedia (FilterPanel) in jsdom.
vi.mock('@/components/filters/LibraryFilterPanel', () => ({
  LibraryFilterPanel: () => <div data-testid="stub-library-filter-panel" />,
}));

// Stub useUserProfile — FlawsTab reads is_guest (defaults to false here) for guest gating.
vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({
    data: { chess_com_game_count: 5, lichess_game_count: 10 },
  }),
}));

// EvalCoverageBadge (rendered by FlawsTab) now calls useAuth().logoutForPromotion()
// for the guest sign-up CTA; mock it so the tab renders without an AuthProvider.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ logoutForPromotion: vi.fn() }),
}));

// ── Controlled useLibraryFlaws mock ───────────────────────────────────────────

type MockFlawsResult = {
  data?: {
    flaws: Array<{
      game_id: number;
      ply: number;
      fen: string;
      move_san: string | null;
      severity: 'mistake' | 'blunder';
      tags: string[];
      eval_cp_before: number | null;
      eval_mate_before: number | null;
      eval_cp_after: number | null;
      eval_mate_after: number | null;
      white_rating: number | null;
      black_rating: number | null;
      user_result: 'win' | 'draw' | 'loss';
      played_at: string | null;
      time_control_bucket: string | null;
      time_control_str: string | null;
      ply_count: number | null;
      termination: string | null;
      platform: string;
      platform_url: string | null;
      white_username: string | null;
      black_username: string | null;
      user_color: string;
    }>;
    matched_count: number;
    offset: number;
    limit: number;
  };
  isLoading: boolean;
  isError: boolean;
};

let mockFlawsResult: MockFlawsResult = {
  data: { flaws: [], matched_count: 0, offset: 0, limit: 20 },
  isLoading: false,
  isError: false,
};

// Controllable flaw-stats mock — analyzed_n decides which matched_count=0 empty
// state renders (NoEngineAnalysisFlawsState vs "No flaws matched"). Args are
// captured so tests can assert the probe is filter-independent.
let mockStatsResult: { data: { analyzed_n: number } | undefined } = { data: undefined };
let capturedStatsArgs: unknown[] | null = null;

vi.mock('@/hooks/useLibrary', () => ({
  useLibraryFlaws: () => mockFlawsResult,
  useLibraryGames: () => ({ data: undefined, isLoading: false, isError: false }),
  useLibraryFlawStats: (...args: unknown[]) => {
    capturedStatsArgs = args;
    return { ...mockStatsResult, isLoading: false, isError: false };
  },
  // useLibraryGame is called by FlawCard (rendered inside the grid); disabled by default
  useLibraryGame: () => ({ data: undefined, isLoading: false, isError: false }),
}));

// ── useFlawFilterStore mock — allows per-test state control ───────────────────

// We need a controllable store: the real store is module-level and persists
// between tests. Instead, mock the entire module with React state.
// Phase 129 / Quick 260620-l5k: include tacticOrientation + depth range defaults.
let mockStoreState = {
  severity: ['blunder', 'mistake'] as ('blunder' | 'mistake')[],
  tags: [] as string[],
  tacticFamilies: [] as string[],
  tacticOrientation: 'either' as const,
  tacticDepthMin: 0,
  tacticDepthMax: 5,
};
const mockSetFlawFilter = vi.fn(
  (updater: typeof mockStoreState | ((prev: typeof mockStoreState) => typeof mockStoreState)) => {
    const next = typeof updater === 'function' ? updater(mockStoreState) : updater;
    mockStoreState = next;
  },
);

vi.mock('@/hooks/useFlawFilterStore', async () => {
  const actual =
    await vi.importActual<typeof import('@/hooks/useFlawFilterStore')>('@/hooks/useFlawFilterStore');
  return {
    ...actual,
    useFlawFilterStore: () => [mockStoreState, mockSetFlawFilter] as const,
  };
});

// ── Import FlawsTab after mocks are in place ──────────────────────────────────

import { FlawsTab } from '../FlawsTab';

// ── Render helper ─────────────────────────────────────────────────────────────

function renderFlawsTab(initialPath = '/library/flaws') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/library/flaws" element={<FlawsTab />} />
            <Route path="/library/import" element={<div data-testid="stub-import" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mockStoreState = {
    severity: ['blunder', 'mistake'],
    tags: [],
    tacticFamilies: [],
    tacticOrientation: 'either',
    tacticDepthMin: 0,
    tacticDepthMax: 5,
  };
  vi.clearAllMocks();
  mockFlawsResult = {
    data: { flaws: [], matched_count: 0, offset: 0, limit: 20 },
    isLoading: false,
    isError: false,
  };
  mockStatsResult = { data: undefined };
  capturedStatsArgs = null;
});

afterEach(() => {
  cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FlawsTab', () => {
  describe('rendering', () => {
    it('renders the flaws tab content root', () => {
      renderFlawsTab();
      expect(screen.getByTestId('flaws-tab-content')).toBeTruthy();
    });

    it('renders the flaw-list section', () => {
      renderFlawsTab();
      // flaw-list appears in both desktop (via SidebarLayout children) and mobile stacked content
      const flawLists = screen.getAllByTestId('flaw-list');
      expect(flawLists.length).toBeGreaterThanOrEqual(1);
    });

    it('renders the FlawFilterControl in the sidebar panel', () => {
      renderFlawsTab();
      // FlawFilterControl rendered inside stub-sidebar-panel (desktop sidebar content)
      // plus in the mobile section (inline in mobile drawer position)
      const controls = screen.getAllByTestId('flaw-filter-control');
      expect(controls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isError branch', () => {
    it('renders the mandatory error message when useLibraryFlaws returns isError', () => {
      mockFlawsResult = { data: undefined, isLoading: false, isError: true };
      renderFlawsTab();
      // Appears in both desktop + mobile sections
      const errorMessages = screen.getAllByText(
        'Failed to load flaws. Something went wrong. Please try again in a moment.',
      );
      expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT render the flaw-list when isError', () => {
      mockFlawsResult = { data: undefined, isLoading: false, isError: true };
      renderFlawsTab();
      // flaw-list section is inside !flawsError check — should not be present
      expect(screen.queryAllByTestId('flaw-list').length).toBe(0);
    });
  });

  describe('flaw list rows', () => {
    it('renders miniboard rows from mocked useLibraryFlaws data', () => {
      mockFlawsResult = {
        data: {
          flaws: [
            {
              game_id: 1,
              ply: 24,
              fen: 'rnbqkb1r/pppp1ppp/4pn2/8/2PP4/8/PP2PPPP/RNBQKBNR',
              move_san: 'Nxd4',
              severity: 'blunder',
              tags: ['reversed'],
              eval_cp_before: 150,
              eval_mate_before: null,
              eval_cp_after: -80,
              eval_mate_after: null,
              white_rating: null,
              black_rating: null,
              user_result: 'loss',
              played_at: '2026-05-01T10:00:00Z',
              time_control_bucket: 'blitz',
              time_control_str: '300+0',
              ply_count: 82,
              termination: 'resignation',
              platform: 'lichess',
              platform_url: 'https://lichess.org/abcd1234',
              white_username: 'opponent',
              black_username: 'testuser',
              user_color: 'black',
            },
            {
              game_id: 2,
              ply: 32,
              fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R',
              move_san: 'Nd4',
              severity: 'mistake',
              tags: ['miss'],
              eval_cp_before: 30,
              eval_mate_before: null,
              eval_cp_after: -20,
              eval_mate_after: null,
              white_rating: null,
              black_rating: null,
              user_result: 'draw',
              played_at: '2026-05-02T12:00:00Z',
              time_control_bucket: 'rapid',
              time_control_str: '600+5',
              ply_count: 116,
              termination: 'timeout',
              platform: 'chess.com',
              platform_url: null,
              white_username: 'testuser',
              black_username: 'opponent2',
              user_color: 'white',
            },
          ],
          matched_count: 2,
          offset: 0,
          limit: 20,
        },
        isLoading: false,
        isError: false,
      };

      renderFlawsTab();

      // Two miniboards in desktop section, two in mobile = 4 total (or 2 if mobile hidden in jsdom)
      const boards = screen.getAllByTestId('stub-mini-board');
      expect(boards.length).toBeGreaterThanOrEqual(2);

      // SeverityBadge elements per flaw (appears in both desktop + mobile)
      expect(screen.getAllByTestId('severity-blunder-1').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId('severity-mistake-2').length).toBeGreaterThanOrEqual(1);

      // Tag chips rendered for each flaw (in both desktop + mobile sections)
      expect(screen.getAllByTestId('stub-tag-chip-reversed').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByTestId('stub-tag-chip-miss').length).toBeGreaterThanOrEqual(1);
    });

    it('deep-links the lichess flaw to the exact ply and chess.com to the plain game', () => {
      mockFlawsResult = {
        data: {
          flaws: [
            {
              game_id: 1,
              ply: 24,
              fen: 'rnbqkb1r/pppp1ppp/4pn2/8/2PP4/8/PP2PPPP/RNBQKBNR',
              move_san: 'Nxd4',
              severity: 'blunder',
              tags: ['reversed'],
              eval_cp_before: 150,
              eval_mate_before: null,
              eval_cp_after: -80,
              eval_mate_after: null,
              white_rating: null,
              black_rating: null,
              user_result: 'loss',
              played_at: '2026-05-01T10:00:00Z',
              time_control_bucket: 'blitz',
              time_control_str: '300+0',
              ply_count: 82,
              termination: 'resignation',
              platform: 'lichess',
              platform_url: 'https://lichess.org/abcd1234',
              white_username: 'opponent',
              black_username: 'testuser',
              user_color: 'black',
            },
            {
              game_id: 2,
              ply: 32,
              fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R',
              move_san: 'Nd4',
              severity: 'mistake',
              tags: ['miss'],
              eval_cp_before: 30,
              eval_mate_before: null,
              eval_cp_after: -20,
              eval_mate_after: null,
              white_rating: null,
              black_rating: null,
              user_result: 'draw',
              played_at: '2026-05-02T12:00:00Z',
              time_control_bucket: 'rapid',
              time_control_str: '600+5',
              ply_count: 116,
              termination: 'timeout',
              platform: 'chess.com',
              platform_url: 'https://www.chess.com/game/live/999',
              white_username: 'testuser',
              black_username: 'opponent2',
              user_color: 'white',
            },
          ],
          matched_count: 2,
          offset: 0,
          limit: 20,
        },
        isLoading: false,
        isError: false,
      };

      renderFlawsTab();

      // Links land on the blunder (position AFTER the flawed move), so a flaw at
      // 0-indexed ply N maps to N + 1 half-moves.
      // Lichess flaw (game 1, ply 24, user played black) → black POV at #25.
      // testid updated: FlawCard uses flaw-card-platform-link-{id}-{ply} (was flaw-card-link-*)
      const lichessLinks = screen.getAllByTestId('flaw-card-platform-link-1-24');
      expect(lichessLinks.length).toBeGreaterThanOrEqual(1);
      expect(lichessLinks[0]?.getAttribute('href')).toBe('https://lichess.org/abcd1234/black#25');

      // chess.com flaw (game 2, ply 32, user played white) → analysis board move=33.
      const chessComLinks = screen.getAllByTestId('flaw-card-platform-link-2-32');
      expect(chessComLinks.length).toBeGreaterThanOrEqual(1);
      expect(chessComLinks[0]?.getAttribute('href')).toBe(
        'https://www.chess.com/analysis/game/live/999?tab=details-tab&move=33',
      );
    });

    it('renders matched count row', () => {
      mockFlawsResult = {
        data: { flaws: [], matched_count: 42, offset: 0, limit: 20 },
        isLoading: false,
        isError: false,
      };
      renderFlawsTab();
      const countEls = screen.getAllByText('42 flaws matched');
      expect(countEls.length).toBeGreaterThanOrEqual(1);
    });

    it('renders singular "flaw" for matched_count=1', () => {
      mockFlawsResult = {
        data: { flaws: [], matched_count: 1, offset: 0, limit: 20 },
        isLoading: false,
        isError: false,
      };
      renderFlawsTab();
      const countEls = screen.getAllByText('1 flaw matched');
      expect(countEls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('empty states', () => {
    it('shows "No flaws matched" when matched_count=0 but analyzed games exist', () => {
      mockFlawsResult = {
        data: { flaws: [], matched_count: 0, offset: 0, limit: 20 },
        isLoading: false,
        isError: false,
      };
      mockStatsResult = { data: { analyzed_n: 12 } };
      renderFlawsTab();
      const headings = screen.getAllByText('No flaws matched');
      expect(headings.length).toBeGreaterThanOrEqual(1);
      const captions = screen.getAllByText('Try adjusting the flaw filter or game filters.');
      expect(captions.length).toBeGreaterThanOrEqual(1);
    });

    it('probes flaw stats filter-independently (no inherited game/flaw filters)', () => {
      // Even with a restrictive flaw filter applied, the analyzed_n probe must
      // run unfiltered — otherwise a zero-match filter set yields analyzed_n=0
      // and falsely shows the no-engine-analysis message.
      // Phase 129: include all FlawFilterState fields so FlawsTab doesn't crash.
      mockStoreState = {
        severity: ['blunder'],
        tags: ['miss'],
        tacticFamilies: [],
        tacticOrientation: 'either',
        tacticDepthMin: 0,
        tacticDepthMax: 5,
      };
      renderFlawsTab();
      expect(capturedStatsArgs).toBeTruthy();
      const [probeFilters, probeFlawFilter] = capturedStatsArgs! as [
        { opponentType: string; recency: unknown },
        { severity: string[]; tags: string[] },
      ];
      expect(probeFilters.opponentType).toBe('both');
      expect(probeFilters.recency).toBeNull();
      expect(probeFlawFilter.severity).toEqual([]);
      expect(probeFlawFilter.tags).toEqual([]);
    });

    it('shows the no-engine-analysis state when no games are analyzed (quick-260610-vru)', () => {
      mockFlawsResult = {
        data: { flaws: [], matched_count: 0, offset: 0, limit: 20 },
        isLoading: false,
        isError: false,
      };
      mockStatsResult = { data: { analyzed_n: 0 } };
      renderFlawsTab();
      const states = screen.getAllByTestId('flaws-no-engine-analysis');
      expect(states.length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('No flaws matched')).toBeNull();
    });
  });

  describe('URL sync — deep-link pre-population', () => {
    it('initializes the store from URL params on mount when ?tag=reversed', () => {
      // The FlawsTab reads URL params on mount and calls setFlawFilter
      renderFlawsTab('/library/flaws?tag=reversed');

      // setFlawFilter should have been called with reversed tag
      expect(mockSetFlawFilter).toHaveBeenCalled();
      // Find the call that set the reversed tag
      const calls = (mockSetFlawFilter as Mock).mock.calls;
      const tagSetCall = calls.find((call) => {
        const arg = call[0];
        const resolved = typeof arg === 'function' ? arg(mockStoreState) : arg;
        return Array.isArray(resolved.tags) && resolved.tags.includes('reversed');
      });
      expect(tagSetCall).toBeTruthy();
    });

    it('reflects store state with tags in the FlawFilterControl (tag button selected)', () => {
      // Set store to have a tag pre-selected (simulating deep-link result).
      // Phase 129: include all FlawFilterState fields so FlawsTab doesn't crash.
      mockStoreState = {
        severity: ['blunder', 'mistake'],
        tags: ['miss'],
        tacticFamilies: [],
        tacticOrientation: 'either',
        tacticDepthMin: 0,
        tacticDepthMax: 5,
      };
      renderFlawsTab('/library/flaws');

      // The "miss" tag is a Context tag — the Context section now renders inline (no
      // collapse), so its tag buttons are available without expanding anything.

      // The "miss" tag button should appear as aria-pressed=true in the FlawFilterControl.
      // The Clear affordance is now in FilterActions (Reset button), not in FlawFilterControl.
      const missBtns = screen.getAllByTestId('filter-flaw-tag-miss');
      expect(missBtns.length).toBeGreaterThanOrEqual(1);
      // At least one should be selected
      const selectedMiss = missBtns.find((b) => b.getAttribute('aria-pressed') === 'true');
      expect(selectedMiss).toBeTruthy();
    });

    it('does NOT call setFlawFilter from URL when no tag/severity params present', () => {
      renderFlawsTab('/library/flaws');
      // Without URL params, the store should not be updated from URL
      expect(mockSetFlawFilter).not.toHaveBeenCalled();
    });
  });
});
