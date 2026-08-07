// @vitest-environment jsdom
/**
 * Phase 88 Plan 07 — integration tests for the EndgameTimePressureSection
 * orchestrator. Verifies:
 * - Only TC cards whose testids match the supplied TCs are rendered.
 * - Empty state renders when cards array is empty.
 * - All 4 TC cards render in canonical order when all four are present.
 * - Legacy data-testid="clock-pressure-section" is absent (proxy for
 *   knip-clean post-deletion of EndgameClockPressureSection).
 * - Section wrapper testid="time-pressure-cards-section" is always present.
 *
 * 260531-f7s: SC-1 grid layout tests replaced with Accordion assertions:
 * - Section renders a controlled Accordion with accordion trigger testids.
 * - The time-weighted primary TC starts expanded (data-state="open").
 * - Other TCs start collapsed (data-state="closed").
 * - Empty state asserts no trigger testids present.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  ClockGapBullet,
  PressureQuintileBullet,
  TimePressureCardsResponse,
  TimePressureTcCard,
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

import { EndgameTimePressureSection } from '../EndgameTimePressureSection';

// ── Payload helpers ────────────────────────────────────────────────────────────

function buildClockGap(): ClockGapBullet {
  return {
    n: 100,
    mean_diff_pct: 0.02,
    p_value: 0.2,
    ci_low: -0.01,
    ci_high: 0.05,
  };
}

function buildQuintile(index: 0 | 1 | 2 | 3 | 4): PressureQuintileBullet {
  const labels: Record<0 | 1 | 2 | 3 | 4, string> = {
    0: '0-20%',
    1: '20-40%',
    2: '40-60%',
    3: '60-80%',
    4: '80-100%',
  };
  return {
    quintile_index: index,
    quintile_label: labels[index],
    n: 20,
    delta: 0.0,
    p_value: 0.5,
    ci_low: -0.05,
    ci_high: 0.05,
    opp_score: 0.5,
  };
}

function buildCard(tc: TimePressureTcCard['tc'], total = 100): TimePressureTcCard {
  return {
    tc,
    total,
    // Plan 88-14 A-3: top-zone summary stats defaults.
    user_avg_pct: 0.47,
    user_avg_seconds: 215,
    opp_avg_pct: 0.52,
    opp_avg_seconds: 231,
    avg_clock_diff_seconds: -16,
    net_timeout_rate: -0.005,
    clock_gap: buildClockGap(),
    quintiles: [
      buildQuintile(0),
      buildQuintile(1),
      buildQuintile(2),
      buildQuintile(3),
      buildQuintile(4),
    ],
  };
}

/**
 * Build a TimePressureCardsResponse with one card per supplied TC.
 * Default all-four-TC payload when called with no args via overload.
 */
function makePayload(
  ...tcs: Array<TimePressureTcCard['tc']>
): TimePressureCardsResponse {
  const tcsToUse =
    tcs.length > 0 ? tcs : (['bullet', 'blitz', 'rapid', 'classical'] as const);
  return {
    cards: tcsToUse.map((tc) => buildCard(tc)),
  };
}

// ── Render helper ──────────────────────────────────────────────────────────────

function renderSection(
  data: TimePressureCardsResponse,
  filterKey?: string,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <EndgameTimePressureSection data={data} filterKey={filterKey} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EndgameTimePressureSection — TC card visibility', () => {
  it('renders visible TC cards and omits hidden ones', () => {
    // Only bullet and rapid are in the payload — blitz and classical absent.
    renderSection(makePayload('bullet', 'rapid'));

    expect(screen.getByTestId('time-pressure-card-bullet')).not.toBeNull();
    expect(screen.getByTestId('time-pressure-card-rapid')).not.toBeNull();
    expect(screen.queryByTestId('time-pressure-card-blitz')).toBeNull();
    expect(screen.queryByTestId('time-pressure-card-classical')).toBeNull();
  });
});

describe('EndgameTimePressureSection — Empty state', () => {
  it('renders empty state when cards array is empty', () => {
    renderSection({ cards: [] });

    expect(screen.getByTestId('time-pressure-cards-empty')).not.toBeNull();
    // No accordion trigger present when there are no cards.
    expect(screen.queryByTestId('time-pressure-card-bullet-trigger')).toBeNull();
  });
});

describe('EndgameTimePressureSection — All 4 TCs', () => {
  it('renders all 4 TC cards in canonical order when payload contains all four', () => {
    renderSection(makePayload('bullet', 'blitz', 'rapid', 'classical'));

    expect(screen.getByTestId('time-pressure-card-bullet')).not.toBeNull();
    expect(screen.getByTestId('time-pressure-card-blitz')).not.toBeNull();
    expect(screen.getByTestId('time-pressure-card-rapid')).not.toBeNull();
    expect(screen.getByTestId('time-pressure-card-classical')).not.toBeNull();
  });
});

describe('EndgameTimePressureSection — Legacy absence (knip-clean proxy)', () => {
  it('asserts legacy data-testid="clock-pressure-section" is absent', () => {
    renderSection(makePayload('bullet', 'blitz', 'rapid', 'classical'));

    expect(screen.queryByTestId('clock-pressure-section')).toBeNull();
  });
});

describe('EndgameTimePressureSection — grandTotal propagation', () => {
  it('passes the summed total to each card so the percentage in the title is consistent across cards', () => {
    // 4 cards × 100 games each → grandTotal = 400 → each card is 25%.
    renderSection(makePayload('bullet', 'blitz', 'rapid', 'classical'));

    for (const tc of ['bullet', 'blitz', 'rapid', 'classical'] as const) {
      const total = screen.getByTestId(`time-pressure-card-${tc}-total`);
      expect(total.textContent).toContain('Games: 25% (100)');
    }
  });
});

describe('EndgameTimePressureSection — Section wrapper', () => {
  it('wraps content in a section with time-pressure-cards-section testid', () => {
    renderSection(makePayload('bullet', 'blitz', 'rapid', 'classical'));

    expect(screen.getByTestId('time-pressure-cards-section')).not.toBeNull();
  });

  it('exposes a non-dangling accessible name on the section', () => {
    // Phase 88.1 WR-02 / IN-05: section uses aria-label (self-contained),
    // not aria-labelledby pointing at a non-existent heading id.
    const { container } = renderSection(
      makePayload('bullet', 'blitz', 'rapid', 'classical'),
    );
    const section = container.querySelector(
      '[data-testid="time-pressure-cards-section"]',
    );
    expect(section).not.toBeNull();
    expect(section!.getAttribute('aria-label')).toBe('Time pressure analysis');
    expect(section!.getAttribute('aria-labelledby')).toBeNull();
  });
});

describe('EndgameTimePressureSection — SC-1: Accordion layout (replaces dynamic grid)', () => {
  it('renders accordion trigger testids for all present TC cards', () => {
    renderSection(makePayload('bullet', 'blitz', 'rapid', 'classical'));

    // All 4 triggers must be present (AccordionTrigger always renders).
    expect(screen.getByTestId('time-pressure-card-bullet-trigger')).not.toBeNull();
    expect(screen.getByTestId('time-pressure-card-blitz-trigger')).not.toBeNull();
    expect(screen.getByTestId('time-pressure-card-rapid-trigger')).not.toBeNull();
    expect(screen.getByTestId('time-pressure-card-classical-trigger')).not.toBeNull();
  });

  it('time-weighted primary TC starts expanded; others start collapsed', () => {
    // Give blitz the highest total so it is the time-weighted primary.
    const data: TimePressureCardsResponse = {
      cards: [
        buildCard('bullet', 50),
        buildCard('blitz', 500),
        buildCard('rapid', 100),
        buildCard('classical', 20),
      ],
    };
    const { container } = renderSection(data, 'initial');

    // Accordion state is stored on the AccordionItem (data-testid = card testid).
    const blitzItem = container.querySelector('[data-testid="time-pressure-card-blitz"]');
    const bulletItem = container.querySelector('[data-testid="time-pressure-card-bullet"]');
    const rapidItem = container.querySelector('[data-testid="time-pressure-card-rapid"]');
    const classicalItem = container.querySelector('[data-testid="time-pressure-card-classical"]');

    expect(blitzItem?.getAttribute('data-state')).toBe('open');
    expect(bulletItem?.getAttribute('data-state')).toBe('closed');
    expect(rapidItem?.getAttribute('data-state')).toBe('closed');
    expect(classicalItem?.getAttribute('data-state')).toBe('closed');
  });

  it('does not render old grid class constants (w-1/2 / grid-cols-2 etc.)', () => {
    const { container } = renderSection(makePayload('bullet'));
    // The accordion wrapper must not use the old half-width grid class.
    const accordionRoot = container.querySelector(
      '[data-testid="time-pressure-cards-section"] > p + div',
    );
    expect(accordionRoot?.className).not.toContain('w-1/2');
    expect(accordionRoot?.className).not.toContain('grid');
  });
});
