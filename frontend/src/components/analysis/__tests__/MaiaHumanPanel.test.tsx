// @vitest-environment jsdom
/**
 * Phase 151 Plan 06 — MaiaHumanPanel tests.
 *
 * Thin composition component: a Card whose header carries the title + info tooltip
 * and whose body holds the MovesByRatingChart. The ELO selector was moved OUT of
 * this card in 155 UAT (it drives both engines), so it is no longer asserted here.
 * Verifies wiring, not the child components' own behavior (each has its own test
 * suite already).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { MaiaHumanPanel } from '../MaiaHumanPanel';

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
  vi.clearAllMocks();
});

describe('MaiaHumanPanel', () => {
  it('renders the chart (ELO selector now lives outside the card, 155 UAT)', () => {
    render(
      <MaiaHumanPanel
        selectedElo={1500}
        perElo={[]}
        playedSan={null}
        bestSan={null}
        shownSans={[]}
        qualityBySan={new Map()}
        mover="white"
        engineTopLines={[]}
        isLadderComplete={false}
      />,
    );
    expect(screen.getByTestId('moves-by-rating-chart')).toBeTruthy();
    // The ELO slider was moved out below the card (155 UAT).
    expect(screen.queryByTestId('analysis-elo-selector')).toBeNull();
  });

  it('renders the header title and the info tooltip trigger (UAT quick 260705-bm3)', () => {
    render(
      <MaiaHumanPanel
        selectedElo={1500}
        perElo={[]}
        playedSan={null}
        bestSan={null}
        shownSans={[]}
        qualityBySan={new Map()}
        mover="white"
        engineTopLines={[]}
        isLadderComplete={false}
      />,
    );
    expect(screen.getByTestId('maia-human-header').textContent).toMatch(/Human Move Probability/);
    expect(screen.getByTestId('maia-info-popover')).toBeTruthy();
  });

  it('no longer renders the removed attribution legal box (UAT quick 260705-bm3)', () => {
    render(
      <MaiaHumanPanel
        selectedElo={1500}
        perElo={[]}
        playedSan={null}
        bestSan={null}
        shownSans={[]}
        qualityBySan={new Map()}
        mover="white"
        engineTopLines={[]}
        isLadderComplete={false}
      />,
    );
    expect(screen.queryByTestId('maia-attribution')).toBeNull();
  });

  it('compact mode drops the header but keeps the chart (151.1 UAT)', () => {
    render(
      <MaiaHumanPanel
        selectedElo={1500}
        perElo={[]}
        playedSan={null}
        bestSan={null}
        shownSans={[]}
        qualityBySan={new Map()}
        mover="white"
        engineTopLines={[]}
        isLadderComplete={false}
        compact
      />,
    );
    expect(screen.queryByTestId('maia-human-header')).toBeNull();
    expect(screen.getByTestId('moves-by-rating-chart')).toBeTruthy();
  });
});
