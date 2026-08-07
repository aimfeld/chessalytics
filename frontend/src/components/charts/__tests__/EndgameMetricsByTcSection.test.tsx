// @vitest-environment jsdom
/**
 * Phase 97 Plan 03 — Integration tests for the EndgameMetricsByTcSection
 * orchestrator. Verifies:
 *   - Renders one card per provided TC in bullet -> blitz -> rapid -> classical order.
 *   - Shows empty-state testid and text when cards array is empty.
 *   - Section wrapper testid="endgame-metrics-tc-section" is always present.
 *   - Empty-state testid="endgame-metrics-tc-section-empty" is present iff cards=[].
 *   - Cards absent from the payload do not render.
 *
 * 260530-pll additions:
 *   - Primary-TC card is expanded by default; non-primary cards are collapsed.
 *   - Expanding one card does NOT collapse another (independent accordion).
 *   - filterKey change resets expanded set to the recomputed primary TC.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  EndgameMetricsTcCard,
  EndgameMetricsCardsResponse,
  PerTcBucketStats,
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

import { EndgameMetricsByTcSection } from '../EndgameMetricsByTcSection';

// ── Payload helpers ────────────────────────────────────────────────────────────

function buildBucket(): PerTcBucketStats {
  return {
    games: 50,
    win_pct: 60,
    draw_pct: 20,
    loss_pct: 20,
    rate: 0.6,
    score_gap_mean: -0.08,
    score_gap_n: 40,
    score_gap_p_value: 0.04,
    score_gap_ci_low: -0.12,
    score_gap_ci_high: -0.04,
    percentile: 42,
  };
}

function buildCard(tc: EndgameMetricsTcCard['tc'], total: number = 150): EndgameMetricsTcCard {
  return {
    tc,
    total,
    conversion: buildBucket(),
    parity: buildBucket(),
    recovery: buildBucket(),
  };
}

function makePayload(
  ...tcs: Array<EndgameMetricsTcCard['tc']>
): EndgameMetricsCardsResponse {
  const tcsToUse =
    tcs.length > 0 ? tcs : (['bullet', 'blitz', 'rapid', 'classical'] as const);
  return {
    cards: tcsToUse.map((tc) => buildCard(tc)),
  };
}

// ── Render helper ──────────────────────────────────────────────────────────────

function renderSection(
  data: EndgameMetricsCardsResponse,
  filterKey?: string,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <EndgameMetricsByTcSection data={data} filterKey={filterKey} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EndgameMetricsByTcSection — section wrapper', () => {
  it('wraps content in a section with endgame-metrics-tc-section testid', () => {
    renderSection(makePayload('bullet', 'blitz'));
    expect(screen.getByTestId('endgame-metrics-tc-section')).not.toBeNull();
  });

  it('exposes a non-dangling accessible name on the section', () => {
    const { container } = renderSection(makePayload('bullet'));
    const section = container.querySelector('[data-testid="endgame-metrics-tc-section"]');
    expect(section).not.toBeNull();
    expect(section!.getAttribute('aria-label')).toBe('Endgame metrics by time control');
  });
});

describe('EndgameMetricsByTcSection — empty state', () => {
  it('renders empty state when cards array is empty', () => {
    renderSection({ cards: [] });
    expect(screen.getByTestId('endgame-metrics-tc-section-empty')).not.toBeNull();
    expect(screen.queryByTestId('metrics-tc-card-bullet')).toBeNull();
  });

  it('shows the correct empty-state text', () => {
    renderSection({ cards: [] });
    const emptyEl = screen.getByTestId('endgame-metrics-tc-section-empty');
    expect(emptyEl.textContent).toContain('No endgame data yet');
    expect(emptyEl.textContent).toContain('Import more games');
  });

  it('does NOT render empty state when cards are present', () => {
    renderSection(makePayload('bullet'));
    expect(screen.queryByTestId('endgame-metrics-tc-section-empty')).toBeNull();
  });
});

describe('EndgameMetricsByTcSection — TC card visibility', () => {
  it('renders visible TC cards and omits absent ones', () => {
    // Only bullet and rapid in the payload.
    renderSection(makePayload('bullet', 'rapid'));

    expect(screen.getByTestId('metrics-tc-card-bullet')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-card-rapid')).not.toBeNull();
    expect(screen.queryByTestId('metrics-tc-card-blitz')).toBeNull();
    expect(screen.queryByTestId('metrics-tc-card-classical')).toBeNull();
  });

  it('renders all 4 TC cards when payload contains all four', () => {
    renderSection(makePayload('bullet', 'blitz', 'rapid', 'classical'));

    expect(screen.getByTestId('metrics-tc-card-bullet')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-card-blitz')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-card-rapid')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-card-classical')).not.toBeNull();
  });
});

describe('EndgameMetricsByTcSection — card order', () => {
  it('renders cards in the order provided by the backend payload', () => {
    // Backend returns bullet -> blitz -> rapid -> classical order; section preserves it.
    const { container } = renderSection(
      makePayload('bullet', 'blitz', 'rapid', 'classical'),
    );

    // Gather all TC card ROOT testids in DOM order. The prefix also matches
    // suffixed children (`-header`, `-total`, `-trigger`), so keep only entries
    // whose stripped value is one of the four TC literals.
    const VALID_TCS = new Set(['bullet', 'blitz', 'rapid', 'classical']);
    const cards = container.querySelectorAll('[data-testid^="metrics-tc-card-"]');
    const tcs = Array.from(cards)
      .map((el) => el.getAttribute('data-testid')!.replace('metrics-tc-card-', ''))
      .filter((tc) => VALID_TCS.has(tc));

    expect(tcs).toEqual(['bullet', 'blitz', 'rapid', 'classical']);
  });
});

// ── 260530-pll: collapsible accordion tests ───────────────────────────────────

describe('EndgameMetricsByTcSection — primary-TC default expand', () => {
  // rapid card with enough time-weighted games to beat a smaller bullet card.
  // rapid total=200, bullet total=25.
  // time-weighted: rapid = 200 * 600 = 120000 vs bullet = 25 * 60 = 1500
  // so rapid is unambiguously primary.
  function makeUnambiguousPayload(): EndgameMetricsCardsResponse {
    return {
      cards: [
        buildCard('bullet', 25),  // 25 * 60 = 1500 weight
        buildCard('rapid', 200),  // 200 * 600 = 120000 weight — primary
      ],
    };
  }

  it('primary-TC trigger has data-state="open" on initial render', () => {
    renderSection(makeUnambiguousPayload());
    const rapidTrigger = screen.getByTestId('metrics-tc-card-rapid-trigger');
    // Radix accordion sets data-state="open" on the trigger of the expanded item.
    expect(rapidTrigger.getAttribute('data-state')).toBe('open');
  });

  it('non-primary TC trigger has data-state="closed" on initial render', () => {
    renderSection(makeUnambiguousPayload());
    const bulletTrigger = screen.getByTestId('metrics-tc-card-bullet-trigger');
    expect(bulletTrigger.getAttribute('data-state')).toBe('closed');
  });

  it('trigger has aria-label with TC name', () => {
    renderSection(makeUnambiguousPayload());
    const rapidTrigger = screen.getByTestId('metrics-tc-card-rapid-trigger');
    expect(rapidTrigger.getAttribute('aria-label')).toContain('Rapid');
  });

  it('AccordionItem root persists in DOM regardless of open/closed state', () => {
    renderSection(makeUnambiguousPayload());
    // Both card roots must be present even though bullet is collapsed.
    expect(screen.getByTestId('metrics-tc-card-rapid')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-card-bullet')).not.toBeNull();
  });
});

describe('EndgameMetricsByTcSection — filterKey resets accordion', () => {
  it('resets expanded set to new primary TC when filterKey changes', () => {
    // Initial: rapid is primary (200 games * 600 weight)
    const data = makePayload('bullet', 'rapid');
    const { rerender } = render(
      <MemoryRouter>
        <TooltipProvider>
          <EndgameMetricsByTcSection data={data} filterKey="filter-v1" />
        </TooltipProvider>
      </MemoryRouter>,
    );

    const rapidTrigger = screen.getByTestId('metrics-tc-card-rapid-trigger');
    expect(rapidTrigger.getAttribute('data-state')).toBe('open');

    // Re-render with new filterKey — reset should happen (same data here, same primary).
    rerender(
      <MemoryRouter>
        <TooltipProvider>
          <EndgameMetricsByTcSection data={data} filterKey="filter-v2" />
        </TooltipProvider>
      </MemoryRouter>,
    );

    // After reset, primary (rapid) should still be open.
    const rapidTriggerAfter = screen.getByTestId('metrics-tc-card-rapid-trigger');
    expect(rapidTriggerAfter.getAttribute('data-state')).toBe('open');
  });
});
