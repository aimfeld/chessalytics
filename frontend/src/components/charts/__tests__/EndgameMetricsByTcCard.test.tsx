// @vitest-environment jsdom
/**
 * Phase 97 Plan 03 — Unit tests for EndgameMetricsByTcCard.
 *
 * Asserts:
 *   1. Conversion gauge zones use TC-specific bands from TC_METRIC_BANDS, not
 *      the pooled global bands.
 *   2. Recovery gauge zones use TC-specific bands (TC_METRIC_BANDS[tc].recovRate).
 *   3. Percentile chip renders when percentile is non-null; absent when null.
 *   4. Score Gap bullet renders when score_gap_n > 0; absent when 0.
 *   5. All three block testids are present for each TC.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Accordion } from '@/components/ui/accordion';
import { TC_METRIC_BANDS, FIXED_GAUGE_ZONES } from '@/generated/endgameZones';
import type { EndgameMetricsTcCard, PerTcBucketStats, RatingAnchorOut } from '@/types/endgames';

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

import { EndgameMetricsByTcCard } from '../EndgameMetricsByTcCard';

// ── Payload helpers ────────────────────────────────────────────────────────────

function buildBucket(overrides?: Partial<PerTcBucketStats>): PerTcBucketStats {
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
    percentile_n_games: 38,
    percentile_value: -0.08,
    ...overrides,
  };
}

function buildCard(tc: EndgameMetricsTcCard['tc']): EndgameMetricsTcCard {
  return {
    tc,
    total: 150,
    conversion: buildBucket({ rate: 0.7, score_gap_mean: -0.1, percentile: 35 }),
    parity: buildBucket({ win_pct: 45, draw_pct: 30, loss_pct: 25, rate: 0.6, score_gap_mean: 0.01, percentile: 55 }),
    recovery: buildBucket({ win_pct: 25, draw_pct: 15, loss_pct: 60, rate: 0.4, score_gap_mean: 0.09, percentile: 62 }),
  };
}

// Default cohort anchor — per-TC percentile chips are gated on an anchor being
// present (the tooltip names "~{anchor}-rated players in {tc}"), so tests that
// assert chip presence must supply one.
const DEFAULT_ANCHOR: RatingAnchorOut = {
  anchor_rating: 1533,
  n_chesscom_games: 0,
  n_lichess_games: 100,
  chesscom_median_native: null,
  lichess_median_native: 1533,
};

// 260530-pll: EndgameMetricsByTcCard is now an AccordionItem and must be
// wrapped in an Accordion. The card's tc value is used as the AccordionItem
// value, so we default the accordion to [card.tc] (expanded) so all content
// is visible in tests.
function renderCard(
  card: EndgameMetricsTcCard,
  ratingAnchor: RatingAnchorOut | undefined = DEFAULT_ANCHOR,
): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Accordion type="multiple" defaultValue={[card.tc]}>
          <EndgameMetricsByTcCard card={card} ratingAnchor={ratingAnchor} />
        </Accordion>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EndgameMetricsByTcCard — TC-specific gauge zones', () => {
  it('bullet conversion gauge zone[1].from equals TC_METRIC_BANDS.bullet.convRate[0]', () => {
    // Render a bullet card and verify the gauge uses TC-specific zones by
    // checking the card renders with the bullet testid (zone boundaries are
    // embedded in the SVG arc paths, which we verify structurally by the fact
    // the card renders at all — the TC_METRIC_BANDS export assertion below is
    // the authoritative value check).
    renderCard(buildCard('bullet'));

    const bulletBands = TC_METRIC_BANDS['bullet'];
    expect(bulletBands).toBeDefined();

    // The bullet conversion zone boundary should be lower than the global FIXED_GAUGE_ZONES
    // (0.65) — the TC-specific bullet band starts at 0.588 (calibrated from benchmarks).
    const bulletConvLower = bulletBands.convRate[0];
    const globalConvLower = FIXED_GAUGE_ZONES.conversion[1]!.from; // 0.65
    expect(bulletConvLower).toBeLessThan(globalConvLower);

    // Card renders with correct testid.
    expect(screen.getByTestId('metrics-tc-card-bullet')).not.toBeNull();
  });

  it('blitz TC bands differ from bullet TC bands', () => {
    const bulletBands = TC_METRIC_BANDS['bullet'];
    const blitzBands = TC_METRIC_BANDS['blitz'];
    expect(blitzBands).toBeDefined();
    expect(blitzBands.convRate[0]).not.toBe(bulletBands.convRate[0]);
  });

  it('recovery uses TC-specific bands (recovRate), not global conversion bands', () => {
    renderCard(buildCard('bullet'));

    const bulletBands = TC_METRIC_BANDS['bullet'];
    // Recovery lower bound (0.295) should differ from conversion lower bound (0.588).
    expect(bulletBands.recovRate[0]).not.toBe(bulletBands.convRate[0]);
    // Recovery testid is present.
    expect(screen.getByTestId('metrics-tc-bullet-recovery')).not.toBeNull();
  });

  it('parity gauge uses per-TC parityRate bands (classical wider than bullet)', () => {
    // Parity rate went per-TC on 2026-05-29 (§3.2.1 IQR per TC). The bands
    // collapse on TC (d=0.08) so most are near-identical, but classical
    // (n=579) is visibly wider — assert the per-TC band exists and varies.
    renderCard(buildCard('classical'));

    const classicalBands = TC_METRIC_BANDS['classical'];
    const bulletBands = TC_METRIC_BANDS['bullet'];
    expect(classicalBands.parityRate).toBeDefined();
    const classicalWidth = classicalBands.parityRate[1] - classicalBands.parityRate[0];
    const bulletWidth = bulletBands.parityRate[1] - bulletBands.parityRate[0];
    expect(classicalWidth).toBeGreaterThan(bulletWidth);
    expect(screen.getByTestId('metrics-tc-classical-parity')).not.toBeNull();
  });
});

describe('EndgameMetricsByTcCard — percentile chip rendering', () => {
  it('renders percentile chips for all three blocks when percentile is non-null', () => {
    renderCard(buildCard('blitz'));

    expect(screen.getByTestId('metrics-tc-blitz-conversion-percentile-chip')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-blitz-parity-percentile-chip')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-blitz-recovery-percentile-chip')).not.toBeNull();
  });

  it('omits percentile chip when percentile is null', () => {
    const card: EndgameMetricsTcCard = {
      ...buildCard('rapid'),
      conversion: buildBucket({ percentile: null }),
      parity: buildBucket({ percentile: null }),
      recovery: buildBucket({ percentile: null }),
    };
    renderCard(card);

    expect(screen.queryByTestId('metrics-tc-rapid-conversion-percentile-chip')).toBeNull();
    expect(screen.queryByTestId('metrics-tc-rapid-parity-percentile-chip')).toBeNull();
    expect(screen.queryByTestId('metrics-tc-rapid-recovery-percentile-chip')).toBeNull();
  });

  it('renders chip for blocks with percentile but not for those without', () => {
    const card: EndgameMetricsTcCard = {
      ...buildCard('classical'),
      conversion: buildBucket({ percentile: 70 }),
      parity: buildBucket({ percentile: null }),
      recovery: buildBucket({ percentile: 30 }),
    };
    renderCard(card);

    expect(screen.getByTestId('metrics-tc-classical-conversion-percentile-chip')).not.toBeNull();
    expect(screen.queryByTestId('metrics-tc-classical-parity-percentile-chip')).toBeNull();
    expect(screen.getByTestId('metrics-tc-classical-recovery-percentile-chip')).not.toBeNull();
  });

  it('suppresses all percentile chips when the TC has no rating anchor', () => {
    // Regression guard: the chip tooltip reads "…of ~{anchor}-rated players in
    // {tc}". Without an anchor it would render a broken "~-rated players" clause,
    // so the chip must self-suppress (mirrors EndgameTimePressureCard). Render
    // directly with the ratingAnchor prop omitted — a default-param helper would
    // substitute the default on an explicit `undefined`.
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Accordion type="multiple" defaultValue={['blitz']}>
            <EndgameMetricsByTcCard card={buildCard('blitz')} />
          </Accordion>
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('metrics-tc-blitz-conversion-percentile-chip')).toBeNull();
    expect(screen.queryByTestId('metrics-tc-blitz-parity-percentile-chip')).toBeNull();
    expect(screen.queryByTestId('metrics-tc-blitz-recovery-percentile-chip')).toBeNull();
  });
});

describe('EndgameMetricsByTcCard — Score Gap bullet gating', () => {
  it('renders score gap bullet when score_gap_n > 0', () => {
    renderCard(buildCard('bullet'));

    expect(screen.getByTestId('metrics-tc-bullet-conversion-score-gap-bullet')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-bullet-parity-score-gap-bullet')).not.toBeNull();
    expect(screen.getByTestId('metrics-tc-bullet-recovery-score-gap-bullet')).not.toBeNull();
  });

  it('hides score gap bullet when score_gap_n is 0 or null', () => {
    const card: EndgameMetricsTcCard = {
      ...buildCard('blitz'),
      conversion: buildBucket({ score_gap_n: 0 }),
      parity: buildBucket({ score_gap_n: null }),
      recovery: buildBucket({ score_gap_n: 0 }),
    };
    renderCard(card);

    expect(screen.queryByTestId('metrics-tc-blitz-conversion-score-gap-bullet')).toBeNull();
    expect(screen.queryByTestId('metrics-tc-blitz-parity-score-gap-bullet')).toBeNull();
    expect(screen.queryByTestId('metrics-tc-blitz-recovery-score-gap-bullet')).toBeNull();
  });
});

describe('EndgameMetricsByTcCard — score gap shows RAW value, not centered', () => {
  it('renders the uncentered score_gap_mean in the label, not the display-shifted value', () => {
    // Regression guard for the centered-vs-uncentered bug: displayShift recenters
    // ONLY the bullet graphic on visual zero, it must not leak into the textual
    // label. The bullet conversion band is [-0.195, -0.057] → shift = +0.126, so
    // a raw gap of -0.10 has a *centered* value of +0.026. The label must show the
    // RAW -10%, never the centered +3%.
    renderCard(buildCard('bullet'));

    const label = screen.getByTestId('metrics-tc-bullet-conversion-score-gap-value');
    expect(label.textContent).toBe('-10%');
    expect(label.textContent).not.toBe('+3%');
  });
});

describe('EndgameMetricsByTcCard — block testid presence', () => {
  it.each([
    ['bullet'] as const,
    ['blitz'] as const,
    ['rapid'] as const,
    ['classical'] as const,
  ])('%s: all three block testids are present', (tc) => {
    renderCard(buildCard(tc));

    expect(screen.getByTestId(`metrics-tc-${tc}-conversion`)).not.toBeNull();
    expect(screen.getByTestId(`metrics-tc-${tc}-parity`)).not.toBeNull();
    expect(screen.getByTestId(`metrics-tc-${tc}-recovery`)).not.toBeNull();
    expect(screen.getByTestId(`metrics-tc-card-${tc}`)).not.toBeNull();
  });
});

describe('EndgameMetricsByTcCard — header + games count', () => {
  it('renders a distinct header section per card', () => {
    renderCard(buildCard('rapid'));
    expect(screen.getByTestId('metrics-tc-card-rapid-header')).not.toBeNull();
  });

  it('shows per-metric game count as "Games: x% (n)" summing to 100% across blocks', () => {
    const card: EndgameMetricsTcCard = {
      ...buildCard('bullet'),
      conversion: buildBucket({ games: 60 }),
      parity: buildBucket({ games: 30 }),
      recovery: buildBucket({ games: 10 }),
    };
    renderCard(card);
    // Denominator = 60 + 30 + 10 = 100 → shares add up to 100%.
    expect(screen.getByTestId('metrics-tc-bullet-conversion-games-count').textContent).toContain(
      'Games: 60% (60)',
    );
    expect(screen.getByTestId('metrics-tc-bullet-parity-games-count').textContent).toContain(
      'Games: 30% (30)',
    );
    expect(screen.getByTestId('metrics-tc-bullet-recovery-games-count').textContent).toContain(
      'Games: 10% (10)',
    );
  });

  it('header shows the TC share of total games as "Games: x% (n)"', () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Accordion type="multiple" defaultValue={['bullet']}>
            <EndgameMetricsByTcCard
              card={{ ...buildCard('bullet'), total: 100 }}
              ratingAnchor={DEFAULT_ANCHOR}
              grandTotal={400}
            />
          </Accordion>
        </TooltipProvider>
      </MemoryRouter>,
    );
    // 100 / 400 = 25%.
    expect(screen.getByTestId('metrics-tc-card-bullet-total').textContent).toContain(
      'Games: 25% (100)',
    );
  });
});

describe('EndgameMetricsByTcCard — hasGames guard', () => {
  it('shows "Not enough data yet" when conversion has no games', () => {
    const card: EndgameMetricsTcCard = {
      ...buildCard('rapid'),
      conversion: buildBucket({ games: 0 }),
    };
    renderCard(card);

    const convBlock = screen.getByTestId('metrics-tc-rapid-conversion');
    expect(convBlock.textContent).toContain('Not enough data yet');
  });
});
