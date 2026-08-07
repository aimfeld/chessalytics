// @vitest-environment jsdom
/**
 * Regression test for the Library landing redirect (quick task 260606-hfy).
 *
 * Bug: /library with games redirected to /openings (outside the Library page).
 * Fix: redirect to /library/games for returning users, /library/import for new.
 *
 * Child components (ImportTab, GamesTab, StatsTab) are stubbed to isolate the
 * redirect logic from their data dependencies.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryPage } from '../LibraryPage';

// ── Stub heavy child components ───────────────────────────────────────────────

vi.mock('@/pages/library/ImportTab', () => ({
  ImportTab: () => <div data-testid="stub-import-tab" />,
}));
vi.mock('@/pages/library/GamesTab', () => ({
  GamesTab: () => <div data-testid="stub-games-tab" />,
}));
vi.mock('@/pages/library/StatsTab', () => ({
  StatsTab: () => <div data-testid="stub-stats-tab" />,
}));

// ── Controllable useUserProfile mock ──────────────────────────────────────────

const profileState: {
  chess_com_game_count: number;
  lichess_game_count: number;
} = { chess_com_game_count: 0, lichess_game_count: 0 };

vi.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: () => ({
    data: { ...profileState },
  }),
}));

afterEach(() => {
  cleanup();
  profileState.chess_com_game_count = 0;
  profileState.lichess_game_count = 0;
});

// ── Location spy ──────────────────────────────────────────────────────────────

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderLibrary(initialPath = '/library') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/library/*"
            element={
              <LibraryPage
                onImportStarted={vi.fn()}
                activeJobIds={[]}
                onJobDismissed={vi.fn()}
              />
            }
          />
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LibraryPage landing redirect (260606-hfy regression)', () => {
  it('with games, /library redirects to /library/games (not /openings)', () => {
    profileState.chess_com_game_count = 10;
    profileState.lichess_game_count = 0;

    renderLibrary('/library');

    // The library-page renders (not redirected away from the Library domain).
    expect(screen.getByTestId('library-page')).not.toBeNull();
    // Games tab content is present — LibraryPage renders desktop+mobile Tabs sections,
    // each containing all TabsContent blocks; getAllByTestId finds both instances.
    expect(screen.getAllByTestId('stub-games-tab').length).toBeGreaterThan(0);
    // Must NOT have redirected to /openings.
    // LocationDisplay renders only for paths outside /library/* — absent = good.
    const locationEl = screen.queryByTestId('location');
    expect(locationEl).toBeNull();
  });

  it('with zero games, /library redirects to /library/import', () => {
    profileState.chess_com_game_count = 0;
    profileState.lichess_game_count = 0;

    renderLibrary('/library');

    expect(screen.getByTestId('library-page')).not.toBeNull();
    expect(screen.getAllByTestId('stub-import-tab').length).toBeGreaterThan(0);
  });
});
