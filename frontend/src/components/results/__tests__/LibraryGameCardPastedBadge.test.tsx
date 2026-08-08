// @vitest-environment jsdom
/**
 * LibraryGameCard "Pasted" badge tests — Phase 208 (D-13, PASTE-05/09).
 *
 * A platform='pgn' game gets a text "Pasted" badge in the platform slot
 * (frontend/src/components/results/LibraryGameCard.tsx's platformIconAndLink
 * span) where a played game's PlatformIcon + external link would render.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';

// Stub Tooltip so tests don't need a TooltipProvider wrapper.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

// Shared flaw filter store stub (LibraryGameCard reads it unconditionally).
vi.mock('@/hooks/useFlawFilterStore', () => ({
  useFlawFilterStore: () => [
    {
      severity: ['blunder', 'mistake'] as string[],
      tags: [] as string[],
      tacticFamilies: [] as string[],
      tacticOrientation: 'either' as const,
      tacticDepthMin: 0,
      tacticDepthMax: 11,
    },
    vi.fn(),
  ] as const,
}));

// Stub the heavy eval chart + lazy board so the card renders cheaply in jsdom.
vi.mock('@/components/library/EvalChart', () => ({
  EvalChart: () => <div data-testid="stub-eval-chart" />,
}));
vi.mock('@/components/board/LazyMiniBoard', () => ({
  LazyMiniBoard: () => <div data-testid="stub-mini-board" />,
}));

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryGameCard } from '../LibraryGameCard';
import type { GameFlawCard } from '@/types/library';

function renderCard(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
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
});

afterEach(() => {
  cleanup();
});

const GAME_ID = 501;

function makeGame(overrides: Partial<GameFlawCard> = {}): GameFlawCard {
  return {
    game_id: GAME_ID,
    user_result: 'win',
    played_at: '2026-03-01T10:00:00Z',
    time_control_bucket: 'rapid',
    platform: 'lichess',
    platform_url: 'https://lichess.org/abc',
    white_username: 'Alice',
    black_username: 'Bob',
    white_rating: 1850,
    black_rating: 1720,
    opening_name: 'Sicilian Defense',
    opening_eco: 'B20',
    user_color: 'white',
    ply_count: 40,
    termination: 'checkmate',
    time_control_str: '10+5',
    result_fen: null,
    severity_counts: { inaccuracy: 0, mistake: 0, blunder: 0 },
    white_accuracy: null,
    black_accuracy: null,
    chips: [],
    analysis_state: 'analyzed',
    eval_series: [{ ply: 0, es: 0.5, eval_cp: 0, eval_mate: null }],
    flaw_markers: [],
    phase_transitions: { middlegame_ply: null, endgame_ply: null },
    moves: ['e4'],
    active_eval_status: null,
    opening_ply_count: 0,
    ...overrides,
  };
}

describe('LibraryGameCard "Pasted" badge (Phase 208, D-13)', () => {
  it('renders the Pasted badge with the text "Pasted" for a platform=pgn game', () => {
    renderCard(
      <LibraryGameCard game={makeGame({ platform: 'pgn', platform_url: null })} />,
    );
    const badges = screen.getAllByTestId(`library-pasted-badge-${GAME_ID}`);
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]?.textContent).toBe('Pasted');
  });

  it('renders no badge for a platform=chess.com game', () => {
    renderCard(
      <LibraryGameCard game={makeGame({ platform: 'chess.com', platform_url: 'https://chess.com/game/1' })} />,
    );
    expect(screen.queryAllByTestId(`library-pasted-badge-${GAME_ID}`)).toHaveLength(0);
  });

  it('renders no empty fields or dangling separator for a pasted game with null rating/TC fields', () => {
    renderCard(
      <LibraryGameCard
        game={makeGame({
          platform: 'pgn',
          platform_url: null,
          white_rating: null,
          black_rating: null,
          time_control_bucket: null,
          time_control_str: null,
        })}
      />,
    );
    // Badge still renders.
    expect(screen.getAllByTestId(`library-pasted-badge-${GAME_ID}`).length).toBeGreaterThan(0);
    // No literal "null"/"undefined" text anywhere on the card, and no empty
    // "()" rating parenthetical (the card guards white_rating/black_rating
    // with `!== null ? ... : ''`).
    const bodyText = document.body.textContent ?? '';
    expect(bodyText).not.toMatch(/\bnull\b/);
    expect(bodyText).not.toMatch(/\bundefined\b/);
    expect(bodyText).not.toContain('()');
    // The card's existing conditional separator (desktopMetaStrip's "·") is
    // guarded per-field (`{timeControlItem && <span>·</span>}`), so a null
    // time_control_bucket must not leave a dangling "· ·" run.
    expect(bodyText).not.toMatch(/·\s*·/);
  });

  it('still renders the badge when a player name is very long (not removed by truncation)', () => {
    const longName = 'A'.repeat(120);
    renderCard(
      <LibraryGameCard
        game={makeGame({
          platform: 'pgn',
          platform_url: null,
          white_username: longName,
          black_username: 'Bob',
        })}
      />,
    );
    const badges = screen.getAllByTestId(`library-pasted-badge-${GAME_ID}`);
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]?.textContent).toBe('Pasted');
  });
});
