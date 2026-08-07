// @vitest-environment jsdom
/**
 * Phase 98: Updated tests for the EndgameTypeBreakdownSection accordion
 * orchestrator. Replaces the Phase 87 3-col grid assertions with per-TC
 * accordion assertions.
 *
 * Covers:
 * - Section renders one AccordionItem trigger per eligible TC in
 *   bullet/blitz/rapid/classical order (SC-1, SC-2).
 * - Primary TC (highest games × NOMINAL_DURATION) is the expanded item
 *   by default (SC-2, D-09).
 * - Each TC card renders 4 type tiles (rook/minor_piece/pawn/queen) with
 *   NO Mixed tile (SC-3).
 * - A TC with summed total < MIN_GAMES_PER_TC_CARD is suppressed (SC-7).
 * - Changing filterKey prop resets the expanded card to the recomputed
 *   primary TC (D-12).
 * - Empty state when no eligible TC (all below floor).
 * - Returns null when categoriesByTc is undefined.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// useEvalCoverage calls useQuery which requires a QueryClientProvider.
// Return safe defaults so the component renders without a provider.
vi.mock('@/hooks/useEvalCoverage', () => ({
  useEvalCoverage: () => ({ isPending: false, pendingCount: 0, pct: 100, totalCount: 0, isLoading: false }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  ConversionRecoveryStats,
  EndgameCategoryStats,
  EndgameClass,
} from '@/types/endgames';

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
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
});

afterEach(() => {
  cleanup();
});

import { EndgameTypeBreakdownSection } from '../EndgameTypeBreakdownSection';

const CLASS_LABELS: Record<EndgameClass, string> = {
  rook: 'Rook',
  minor_piece: 'Minor Piece',
  pawn: 'Pawn',
  queen: 'Queen',
  mixed: 'Mixed',
  pawnless: 'Pawnless',
};

function buildConversion(): ConversionRecoveryStats {
  return {
    conversion_pct: 65,
    conversion_games: 50,
    conversion_wins: 32,
    conversion_draws: 5,
    conversion_losses: 13,
    recovery_pct: 40,
    recovery_games: 50,
    recovery_saves: 20,
    recovery_wins: 10,
    recovery_draws: 10,
  };
}

function buildCategory(
  endgameClass: EndgameClass,
  total = 100,
): EndgameCategoryStats {
  return {
    endgame_class: endgameClass,
    label: CLASS_LABELS[endgameClass],
    wins: 50,
    draws: 20,
    losses: 30,
    total,
    win_pct: 50,
    draw_pct: 20,
    loss_pct: 30,
    conversion: buildConversion(),
    score_p_value: 0.01,
    type_achievable_score_gap_mean: 0.05,
    type_achievable_score_gap_n: 80,
    type_achievable_score_gap_p_value: 0.001,
    type_achievable_score_gap_ci_low: 0.02,
    type_achievable_score_gap_ci_high: 0.08,
    type_achievable_score_start_mean: 0.41,
    type_achievable_score_end_mean: 0.46,
    score: 0.6,
    confidence: 'high',
    p_value: 0.01,
    ci_low: 0.52,
    ci_high: 0.68,
    eval_n: 80,
    eval_confidence: 'high',
    eval_baseline_pawns: 0,
  };
}

// Build a categoriesByTc fixture: each TC gets rook/minor_piece/pawn/queen
// (no Mixed, no pawnless). Total per TC is configurable.
type TcKey = 'bullet' | 'blitz' | 'rapid' | 'classical';
const FOUR_TYPES: EndgameClass[] = ['rook', 'minor_piece', 'pawn', 'queen'];

function buildCategoriesByTc(
  totalsByTc: Partial<Record<TcKey, number>>,
): Record<TcKey, EndgameCategoryStats[]> {
  const all: TcKey[] = ['bullet', 'blitz', 'rapid', 'classical'];
  const result = {} as Record<TcKey, EndgameCategoryStats[]>;
  for (const tc of all) {
    const totalPerType = totalsByTc[tc] ?? 0;
    result[tc] = FOUR_TYPES.map((cls) =>
      buildCategory(cls, Math.floor(totalPerType / 4)),
    );
  }
  return result;
}

interface RenderSectionOptions {
  filterKey?: string;
}

function renderSection(
  categoriesByTc: Record<TcKey, EndgameCategoryStats[]> | undefined,
  opts: RenderSectionOptions = {},
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <EndgameTypeBreakdownSection
          categoriesByTc={categoriesByTc}
          filterKey={opts.filterKey ?? 'filter-1'}
          onCategorySelect={vi.fn()}
        />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe('EndgameTypeBreakdownSection — null guard', () => {
  it('returns null when categoriesByTc is undefined', () => {
    const { container } = renderSection(undefined);
    expect(container.firstChild).toBeNull();
  });
});

describe('EndgameTypeBreakdownSection — Layout', () => {
  it('renders the locked sub-question copy', () => {
    renderSection(buildCategoriesByTc({ rapid: 100 }));
    expect(
      screen.getByText(
        /Which Endgame Types did you convert or defend poorly/i,
      ),
    ).not.toBeNull();
  });

  it('renders the section container with locked testid', () => {
    renderSection(buildCategoriesByTc({ rapid: 100 }));
    expect(screen.getByTestId('endgame-type-breakdown-section')).not.toBeNull();
  });

  it('does NOT render lg:grid-cols-3 (old 3-col grid removed)', () => {
    renderSection(buildCategoriesByTc({ rapid: 100 }));
    const section = screen.getByTestId('endgame-type-breakdown-section');
    // The section must not contain any element with the old lg:grid-cols-3 class.
    expect(section.innerHTML).not.toContain('lg:grid-cols-3');
  });
});

describe('EndgameTypeBreakdownSection — Accordion items', () => {
  it('renders one accordion trigger per eligible TC in bullet/blitz/rapid/classical order', () => {
    // All four TCs pass the floor (100 total each > MIN_GAMES_PER_TC_CARD=20).
    renderSection(
      buildCategoriesByTc({ bullet: 100, blitz: 100, rapid: 100, classical: 100 }),
    );
    const triggers = [
      screen.getByTestId('type-breakdown-tc-bullet-trigger'),
      screen.getByTestId('type-breakdown-tc-blitz-trigger'),
      screen.getByTestId('type-breakdown-tc-rapid-trigger'),
      screen.getByTestId('type-breakdown-tc-classical-trigger'),
    ];
    expect(triggers).toHaveLength(4);
    // Verify the order: bullet precedes blitz precedes rapid precedes classical.
    const section = screen.getByTestId('endgame-type-breakdown-section');
    const allTriggers = Array.from(section.querySelectorAll('[data-testid^="type-breakdown-tc-"][data-testid$="-trigger"]'));
    const testids = allTriggers.map((el) => el.getAttribute('data-testid'));
    expect(testids).toEqual([
      'type-breakdown-tc-bullet-trigger',
      'type-breakdown-tc-blitz-trigger',
      'type-breakdown-tc-rapid-trigger',
      'type-breakdown-tc-classical-trigger',
    ]);
  });

  it('primary TC (highest games × NOMINAL_DURATION) is expanded by default', () => {
    // rapid: 500 games × 600 = 300 000 > bullet: 2000 × 60 = 120 000
    renderSection(
      buildCategoriesByTc({ bullet: 2000, rapid: 500 }),
    );
    // The primary TC accordion item should be expanded. Radix adds
    // data-state="open" on the expanded item.
    const rapidCard = screen.getByTestId('endgame-type-tc-card-rapid');
    expect(rapidCard.getAttribute('data-state')).toBe('open');

    const bulletCard = screen.getByTestId('endgame-type-tc-card-bullet');
    expect(bulletCard.getAttribute('data-state')).toBe('closed');
  });

  it('renders 4 type tiles (rook/minor_piece/pawn/queen) with NO Mixed tile in expanded TC', () => {
    // rapid is primary (500 × 600 > others).
    renderSection(buildCategoriesByTc({ rapid: 500 }));

    // The tiles in the rapid card use testid pattern type-card-rapid-{slug}.
    expect(screen.getByTestId('endgame-type-tc-card-rapid')).not.toBeNull();
    // 4 tiles expected: rook, minor-piece, pawn, queen.
    expect(screen.getByTestId('type-card-rapid-rook')).not.toBeNull();
    expect(screen.getByTestId('type-card-rapid-minor-piece')).not.toBeNull();
    expect(screen.getByTestId('type-card-rapid-pawn')).not.toBeNull();
    expect(screen.getByTestId('type-card-rapid-queen')).not.toBeNull();
    // Mixed must NOT be present.
    expect(screen.queryByTestId('type-card-rapid-mixed')).toBeNull();
  });
});

describe('EndgameTypeBreakdownSection — Games floor suppression (SC-7)', () => {
  it('suppresses a TC with summed total < MIN_GAMES_PER_TC_CARD (=20)', () => {
    // rapid: 100 games (above floor); bullet: 8 games (below floor).
    renderSection(
      buildCategoriesByTc({ rapid: 100, bullet: 8 }),
    );
    expect(screen.getByTestId('type-breakdown-tc-rapid-trigger')).not.toBeNull();
    expect(screen.queryByTestId('type-breakdown-tc-bullet-trigger')).toBeNull();
  });

  it('renders empty state when all TCs are below floor', () => {
    renderSection(buildCategoriesByTc({ rapid: 4, bullet: 4 }));
    expect(screen.getByTestId('endgame-type-breakdown-empty')).not.toBeNull();
    expect(
      screen.getByText(/No endgame type data yet/i),
    ).not.toBeNull();
  });
});

describe('EndgameTypeBreakdownSection — Filter-change reset (D-12)', () => {
  it('resets expanded TC to the recomputed primary when filterKey changes', () => {
    // Initial: rapid is primary (500 × 600 = 300 000).
    const { rerender } = renderSection(
      buildCategoriesByTc({ bullet: 2000, rapid: 500 }),
      { filterKey: 'filters-A' },
    );

    // Rapid should be expanded initially.
    expect(screen.getByTestId('endgame-type-tc-card-rapid').getAttribute('data-state')).toBe('open');

    // Change filter to one where bullet becomes primary (new data: bullet=1000, rapid=20).
    // bullet: 1000 × 60 = 60 000 > rapid: 20 × 600 = 12 000.
    act(() => {
      rerender(
        <MemoryRouter>
          <TooltipProvider>
            <EndgameTypeBreakdownSection
              categoriesByTc={buildCategoriesByTc({ bullet: 1000, rapid: 20 })}
              filterKey="filters-B"
              onCategorySelect={vi.fn()}
            />
          </TooltipProvider>
        </MemoryRouter>,
      );
    });

    // Now bullet should be expanded, rapid closed.
    expect(screen.getByTestId('endgame-type-tc-card-bullet').getAttribute('data-state')).toBe('open');
    expect(screen.getByTestId('endgame-type-tc-card-rapid').getAttribute('data-state')).toBe('closed');
  });
});
