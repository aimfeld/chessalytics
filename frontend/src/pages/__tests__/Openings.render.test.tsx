// @vitest-environment jsdom
/**
 * Phase 215 Plan 07 — Openings.tsx render-level characterization test.
 *
 * This is the FIRST render-level oracle for OpeningsPage. No other test file
 * in the repository mounts `OpeningsPage` — `Openings.statsBoard.test.tsx`
 * deliberately avoids a full-page render (see its own header comment) and
 * only exercises `getBoardContainerClassName` in isolation.
 *
 * Mirrors `Analysis.test.tsx`'s provider stack (MemoryRouter +
 * QueryClientProvider + TooltipProvider), its single-mutable-state-object
 * mock convention, and its jsdom shims (matchMedia / ResizeObserver /
 * scrollTo / scrollIntoView). `ChessBoard` is mocked to a stub div, matching
 * `Bots.test.tsx`'s precedent — board mechanics are out of scope here.
 *
 * The desktop layout (`hidden lg:flex`) and the mobile layout (`lg:hidden`)
 * are BOTH unconditionally present in the React tree — jsdom does not
 * evaluate the Tailwind breakpoint classes, so both are always mounted
 * simultaneously and queryable, regardless of window size. Only the
 * SidebarLayout desktop panel content and the mobile MobileFilterDrawer
 * content are conditionally mounted (on `activePanel`/`open`), so the tests
 * below open each affordance before asserting on its content, and scope
 * queries with `within(...)` since the desktop `FilterPanel` and the mobile
 * `FilterPanel` share the same non-suffixed testids (e.g. `filter-recency`)
 * and could otherwise collide if both are open at once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { OpeningsPage } from '@/pages/Openings';

// ── Mock ChessBoard: jsdom has no real board-gesture layer, and board
// mechanics are not what this test guards (mirrors Bots.test.tsx). ─────────
vi.mock('@/components/board/ChessBoard', () => ({
  ChessBoard: () => <div data-testid="chessboard" />,
}));

// ── Single-mutable-state-object mocks for the page's data hooks (Analysis.
// test.tsx convention). Each hook returns a fixed, minimal shape — this test
// asserts render/testid presence, not data-driven behavior. ────────────────
const profileState: { data: { chess_com_game_count: number; lichess_game_count: number } | undefined } = {
  data: { chess_com_game_count: 10, lichess_game_count: 0 },
};
vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({ data: profileState.data }),
}));

vi.mock('@/hooks/useNextMoves', () => ({
  useNextMoves: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock('@/hooks/useOpenings', () => ({
  useOpeningsPositionQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

const bookmarksState: { data: unknown[] } = { data: [] };
vi.mock('@/hooks/usePositionBookmarks', () => ({
  usePositionBookmarks: () => ({ data: bookmarksState.data }),
  useCreatePositionBookmark: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateMatchSide: () => ({ mutate: vi.fn() }),
  useTimeSeries: () => ({ data: undefined }),
  // Consumed by useOpeningsHandlers.ts, not Openings.tsx directly — this
  // module mock applies to every importer, so it must be provided too.
  useReorderPositionBookmarks: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/useStats', () => ({
  useMostPlayedOpenings: () => ({ data: undefined, isLoading: false, isError: false }),
  useBookmarkPhaseEntryMetrics: () => ({ data: undefined }),
}));

// ── apiClient: used directly by Openings.tsx (gameCount query) and
// indirectly by useEvalCoverage/useReadiness (EvalCoverageHeader /
// PositionResultsPanel). A single generic response satisfies every consumer
// via their own `?? default` fallbacks — none of them crash on extra or
// missing fields. ────────────────────────────────────────────────────────
vi.mock('@/api/client', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({
      data: {
        count: 0,
        pending_count: 0,
        total_count: 0,
        pct_complete: 100,
        analyzed_count: 0,
        tier1: true,
        tier2: true,
      },
    }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// jsdom shims required by react-chessboard-adjacent code and responsive
// components (mirrors Analysis.test.tsx / Bots.test.tsx precedent).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

if (!('scrollTo' in window) || typeof window.scrollTo !== 'function') {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
}
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = vi.fn();
}

afterEach(() => {
  cleanup();
  profileState.data = { chess_com_game_count: 10, lichess_game_count: 0 };
  bookmarksState.data = [];
});

function renderOpeningsPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={['/openings/explorer']}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <OpeningsPage />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('OpeningsPage render characterization', () => {
  it('renders the page shell and both tab strips (desktop + mobile)', () => {
    renderOpeningsPage();
    expect(screen.getByTestId('openings-page')).toBeTruthy();

    // Desktop tab strip
    const desktopTabs = screen.getByTestId('openings-tabs');
    expect(within(desktopTabs).getByTestId('tab-move-explorer')).toBeTruthy();
    expect(within(desktopTabs).getByTestId('tab-games')).toBeTruthy();
    expect(within(desktopTabs).getByTestId('tab-stats')).toBeTruthy();
    expect(within(desktopTabs).getByTestId('tab-insights')).toBeTruthy();

    // Mobile tab strip — both layouts are unconditionally in the tree (only
    // CSS-hidden via `hidden lg:flex` / `lg:hidden`, which jsdom ignores).
    const mobileTabs = screen.getByTestId('openings-tabs-mobile');
    expect(within(mobileTabs).getByTestId('tab-move-explorer-mobile')).toBeTruthy();
    expect(within(mobileTabs).getByTestId('tab-games-mobile')).toBeTruthy();
    expect(within(mobileTabs).getByTestId('tab-stats-mobile')).toBeTruthy();
    expect(within(mobileTabs).getByTestId('tab-insights-mobile')).toBeTruthy();
  });

  it('desktop sidebar filters panel renders the desktop piece-filter testids and FilterPanel', async () => {
    renderOpeningsPage();
    fireEvent.click(screen.getByTestId('sidebar-strip-btn-filters'));

    const panel = await waitFor(() => screen.getByTestId('sidebar-panel'));
    expect(within(panel).getByTestId('filter-piece-filter')).toBeTruthy();
    expect(within(panel).getByTestId('filter-piece-filter-mine')).toBeTruthy();
    expect(within(panel).getByTestId('filter-piece-filter-opponent')).toBeTruthy();
    expect(within(panel).getByTestId('filter-piece-filter-both')).toBeTruthy();
    // FilterPanel itself rendered inside the desktop panel (unsuffixed testid).
    expect(within(panel).getByTestId('filter-recency')).toBeTruthy();
  });

  it('desktop sidebar bookmarks panel renders the bookmark list', async () => {
    renderOpeningsPage();
    fireEvent.click(screen.getByTestId('sidebar-strip-btn-bookmarks'));

    const panel = await waitFor(() => screen.getByTestId('sidebar-panel'));
    expect(within(panel).getByTestId('btn-bookmark')).toBeTruthy();
    expect(within(panel).getByTestId('btn-suggest-bookmarks')).toBeTruthy();
  });

  it('mobile filter drawer renders the -sidebar-suffixed piece-filter testids and FilterPanel', async () => {
    renderOpeningsPage();
    fireEvent.click(screen.getByTestId('subnav-filter-button'));

    const drawer = await waitFor(() => screen.getByTestId('drawer-filter-sidebar'));
    expect(within(drawer).getByTestId('filter-piece-filter-sidebar')).toBeTruthy();
    expect(within(drawer).getByTestId('filter-piece-filter-mine-sidebar')).toBeTruthy();
    expect(within(drawer).getByTestId('filter-piece-filter-opponent-sidebar')).toBeTruthy();
    expect(within(drawer).getByTestId('filter-piece-filter-both-sidebar')).toBeTruthy();
    // FilterPanel itself rendered inside the mobile drawer (unsuffixed testid).
    expect(within(drawer).getByTestId('filter-recency')).toBeTruthy();
  });

  it('mobile bookmarks drawer renders', async () => {
    renderOpeningsPage();
    fireEvent.click(screen.getByTestId('btn-open-bookmark-sidebar'));

    const drawer = await waitFor(() => screen.getByTestId('drawer-bookmark-sidebar'));
    expect(within(drawer).getByTestId('btn-bookmark-sidebar')).toBeTruthy();
    expect(within(drawer).getByTestId('btn-suggest-bookmarks-sidebar')).toBeTruthy();
  });

  it('desktop and mobile piece-filter testid sets are simultaneously distinct DOM nodes', async () => {
    renderOpeningsPage();
    fireEvent.click(screen.getByTestId('sidebar-strip-btn-filters'));
    await waitFor(() => screen.getByTestId('sidebar-panel'));
    fireEvent.click(screen.getByTestId('subnav-filter-button'));
    await waitFor(() => screen.getByTestId('drawer-filter-sidebar'));

    // Both open at once — the desktop and `-sidebar` testids are different
    // strings by design (Pitfall 3, 215-RESEARCH.md) and must coexist.
    expect(screen.getByTestId('filter-piece-filter')).toBeTruthy();
    expect(screen.getByTestId('filter-piece-filter-sidebar')).toBeTruthy();
    expect(screen.getByTestId('filter-piece-filter')).not.toBe(
      screen.getByTestId('filter-piece-filter-sidebar'),
    );
  });

  it('closing the desktop filters panel unmounts its content (mutation-sensitive: guards the open/close affordance itself)', async () => {
    renderOpeningsPage();
    fireEvent.click(screen.getByTestId('sidebar-strip-btn-filters'));
    await waitFor(() => screen.getByTestId('sidebar-panel'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-strip-btn-filters'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('sidebar-panel')).toBeNull();
    });
  });
});
