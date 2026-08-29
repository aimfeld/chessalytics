// @vitest-environment jsdom
/**
 * Phase 151.1 Plan 04 — MovesByRatingChart tests.
 *
 * Verifies the D-01/D-03/D-07 quality-coloring model: the chart renders exactly
 * the caller-selected `shownSans`, colors each line/label by its `qualityBySan`
 * bucket (ungraded → MOVE_QUALITY_PENDING, D-05), keeps stroke width decoupled
 * from color (played/best always emphasized regardless of quality color), and
 * the D-08 tooltip surfaces the quality word + white-POV eval alongside prob%.
 * Supersedes Phase 151 Plan 05's capMovesByPeak-based tests (that cap moved to
 * `selectCandidatesByMass` in Plan 02 and is computed upstream in Analysis.tsx).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { cloneElement, isValidElement } from 'react';
import type { ReactElement } from 'react';

// Recharts' <ResponsiveContainer> measures its parent with ResizeObserver; in
// jsdom the parent has zero dimensions so the inner chart refuses to render.
// Stub it with a fixed-size wrapper (same pattern as
// EndgameClockDiffOverTimeChart.test.tsx / EndgameScoreOverTimeChart.test.tsx).
vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => (
      <div style={{ width: 800, height: 400 }}>
        {isValidElement(children)
          ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
              width: 800,
              height: 400,
            })
          : children}
      </div>
    ),
  };
});

import {
  MOVE_LABEL_LINE_HEIGHT,
  MovesByRatingChart,
  MovesByRatingTooltipContent,
  spreadLabels,
  type EndLabelDatum,
} from '../MovesByRatingChart';
import type { MoveQualityEval } from '../MovesByRatingChart';
import type { MoveCurvePoint } from '@/hooks/useMaiaEngine';
import { MOVE_QUALITY_BLUNDER, MOVE_QUALITY_PENDING } from '@/lib/theme';
import {
  reportEngineAssetProgress,
  resetEngineAssetsForTests,
} from '@/lib/engine/engineAssetProgress';

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
  resetEngineAssetsForTests();
});

/**
 * Fixture with 6 candidate moves across 5 ELO rungs (mirrors spike 006's Ne4
 * example). `shownSans`/`qualityBySan` are supplied explicitly by the caller
 * (Analysis.tsx's selectCandidatesByMass + classifyMoveQuality) rather than
 * derived internally — this component no longer computes its own cap.
 */
function makePerElo(): MoveCurvePoint[] {
  const elos = [1100, 1300, 1500, 1700, 1900];
  const curves: Record<string, number[]> = {
    e4: [40, 45, 50, 48, 42],
    'O-O': [30, 38, 45, 40, 35],
    h3: [25, 30, 40, 35, 28],
    Qd2: [20, 25, 35, 30, 22],
    a3: [15, 20, 30, 25, 18],
    Ne4: [4, 6, 8, 5, 3],
  };
  return elos.map((elo, i) => ({
    elo,
    moveProbabilities: Object.fromEntries(
      Object.entries(curves).map(([san, vals]) => [san, (vals[i] ?? 0) / 100]),
    ),
  }));
}

const SHOWN_SANS = ['e4', 'O-O', 'h3', 'Qd2', 'a3', 'Ne4'];

function makeQualityBySan(): Map<string, MoveQualityEval> {
  return new Map<string, MoveQualityEval>([
    ['e4', { quality: 'good', evalCp: 30, evalMate: null }],
    ['O-O', { quality: 'best', evalCp: 45, evalMate: null }],
    ['h3', { quality: 'inaccuracy', evalCp: -10, evalMate: null }],
    ['Qd2', { quality: 'mistake', evalCp: -80, evalMate: null }],
    // Ne4 (played) is a blunder — verifies color/stroke decoupling: played stays
    // EMPHASIZED_STROKE_WIDTH even though colored red (D-01/D-07).
    ['Ne4', { quality: 'blunder', evalCp: -400, evalMate: null }],
    // a3 intentionally omitted — an ungraded SHOWN move must render PENDING (D-05).
  ]);
}

describe('MovesByRatingChart', () => {
  it('renders the container with data-testid="moves-by-rating-chart"', () => {
    render(
      <MovesByRatingChart
        perElo={makePerElo()}
        playedSan="Ne4"
        bestSan="O-O"
        selectedElo={1500}
        shownSans={SHOWN_SANS}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    expect(screen.getByTestId('moves-by-rating-chart')).toBeTruthy();
  });

  it('renders exactly one line per shownSans entry (no internal cap)', () => {
    const { container } = render(
      <MovesByRatingChart
        perElo={makePerElo()}
        playedSan="Ne4"
        bestSan="O-O"
        selectedElo={1500}
        shownSans={SHOWN_SANS}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    const lines = container.querySelectorAll('.recharts-line-curve');
    expect(lines.length).toBe(SHOWN_SANS.length);
  });

  it('colors a blunder-graded played move MOVE_QUALITY_BLUNDER while keeping the emphasized stroke width', () => {
    const { container } = render(
      <MovesByRatingChart
        perElo={makePerElo()}
        playedSan="Ne4"
        bestSan="O-O"
        selectedElo={1500}
        shownSans={SHOWN_SANS}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    const lines = container.querySelectorAll('.recharts-line-curve');
    const blunderLine = Array.from(lines).find(
      (el) => el.getAttribute('stroke') === MOVE_QUALITY_BLUNDER,
    );
    expect(blunderLine).toBeTruthy();
    // Played/best keep EMPHASIZED_STROKE_WIDTH (3) regardless of quality color.
    expect(blunderLine?.getAttribute('stroke-width')).toBe('3');
  });

  it('renders a non-emphasized shown move at OTHER_STROKE_WIDTH', () => {
    const { container } = render(
      <MovesByRatingChart
        perElo={makePerElo()}
        playedSan="Ne4"
        bestSan="O-O"
        selectedElo={1500}
        shownSans={SHOWN_SANS}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    const lines = container.querySelectorAll('.recharts-line-curve');
    const mutedLine = Array.from(lines).find((el) => el.getAttribute('stroke-width') === '1.5');
    expect(mutedLine).toBeTruthy();
  });

  it('renders an ungraded shown move (a3) with MOVE_QUALITY_PENDING', () => {
    const { container } = render(
      <MovesByRatingChart
        perElo={makePerElo()}
        playedSan="Ne4"
        bestSan="O-O"
        selectedElo={1500}
        shownSans={SHOWN_SANS}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    const lines = container.querySelectorAll('.recharts-line-curve');
    const pendingLine = Array.from(lines).find(
      (el) => el.getAttribute('stroke') === MOVE_QUALITY_PENDING,
    );
    expect(pendingLine).toBeTruthy();
  });

  it('renders the "you are here" reference line without a text label (151.1 UAT)', () => {
    render(
      <MovesByRatingChart
        perElo={makePerElo()}
        playedSan="Ne4"
        bestSan="O-O"
        selectedElo={1700}
        shownSans={SHOWN_SANS}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    // The "You: <elo>" label was removed; the dashed white marker line remains.
    expect(screen.queryByTestId('moves-by-rating-you-are-here-label')).toBeNull();
  });

  it('renders a fixed-height loading skeleton (still testid-bearing) when perElo is empty', () => {
    render(
      <MovesByRatingChart
        perElo={[]}
        playedSan={null}
        bestSan={null}
        selectedElo={1500}
        shownSans={[]}
        engineTopLines={[]}
        qualityBySan={new Map()}
      />,
    );
    const el = screen.getByTestId('moves-by-rating-chart');
    expect(el).toBeTruthy();
    // Pulsing placeholder keeps the card height constant until Maia is ready.
    expect(screen.getByTestId('moves-by-rating-chart-skeleton')).toBeTruthy();
    // The waiting text is kept (sr-only) for screen readers.
    expect(el.textContent).toMatch(/Waiting/i);
  });

  // ─── G-213-34 (supersedes D-12): the Maia chart skeleton reads no download state ──

  it('even while the Maia model asset is actively downloading, the perElo-empty skeleton renders no progress element and no percent text (inverted regression guard)', () => {
    // Drive the REAL store into its downloading state — the exact condition
    // that used to trigger a Progress + readout in this skeleton. Keeping
    // this setup and inverting the assertion is what makes this a guard
    // against reintroducing the readout, not a vacuous test (mutation-proof
    // below).
    reportEngineAssetProgress('maia-model', 42, 100);

    render(
      <MovesByRatingChart
        perElo={[]}
        playedSan={null}
        bestSan={null}
        selectedElo={1500}
        shownSans={[]}
        engineTopLines={[]}
        qualityBySan={new Map()}
      />,
    );

    const el = screen.getByTestId('moves-by-rating-chart');
    expect(screen.queryByTestId('moves-by-rating-chart-progress')).toBeNull();
    expect(el.textContent).not.toContain('%');
    expect(screen.getByTestId('moves-by-rating-chart-skeleton')).toBeTruthy();
  });
});

describe('MovesByRatingTooltipContent (D-08)', () => {
  it('shows the quality word, white-POV eval, and prob% for a graded blunder row', () => {
    render(
      <MovesByRatingTooltipContent
        label={1500}
        rows={[{ san: 'Ne4', probability: 0.08, color: MOVE_QUALITY_BLUNDER }]}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    const cells = screen.getByTestId('moves-by-rating-tooltip-row-Ne4').querySelectorAll('td');
    expect(cells[0]?.textContent).toBe('Ne4');
    // Column 1 is the quality badge icon (an inline svg).
    expect(cells[1]?.querySelector('svg')).toBeTruthy();
    expect(cells[2]?.textContent).toBe('Blunder');
    expect(cells[3]?.textContent).toBe('-4.0');
    expect(cells[4]?.textContent).toBe('8%');
  });

  it('shows a positive cp eval with a leading + sign and no redundant suffix for the best move', () => {
    render(
      <MovesByRatingTooltipContent
        label={1500}
        rows={[{ san: 'O-O', probability: 0.45, color: 'oklch(0.4 0.17 145)' }]}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    const cells = screen.getByTestId('moves-by-rating-tooltip-row-O-O').querySelectorAll('td');
    expect(cells[0]?.textContent).toBe('O-O');
    expect(cells[1]?.querySelector('svg')).toBeTruthy();
    expect(cells[2]?.textContent).toBe('Best');
    expect(cells[3]?.textContent).toBe('+0.5');
    expect(cells[4]?.textContent).toBe('45%');
  });

  it('renders "Pending" and an em dash for an ungraded shown move', () => {
    render(
      <MovesByRatingTooltipContent
        label={1500}
        rows={[{ san: 'a3', probability: 0.3 }]}
        engineTopLines={[]}
        qualityBySan={makeQualityBySan()}
      />,
    );
    const cells = screen.getByTestId('moves-by-rating-tooltip-row-a3').querySelectorAll('td');
    expect(cells[0]?.textContent).toBe('a3');
    // Ungraded move: the icon cell is empty (no badge until a grade arrives).
    expect(cells[1]?.querySelector('svg')).toBeNull();
    expect(cells[2]?.textContent).toBe('Pending');
    expect(cells[3]?.textContent).toBe('—');
    expect(cells[4]?.textContent).toBe('30%');
  });

  it('formats a mate score as "#N"', () => {
    const qualityBySan = new Map<string, MoveQualityEval>([
      ['Qh7', { quality: 'best', evalCp: null, evalMate: 3 }],
    ]);
    render(
      <MovesByRatingTooltipContent
        label={1500}
        rows={[{ san: 'Qh7', probability: 0.9 }]}
        engineTopLines={[]}
        qualityBySan={qualityBySan}
      />,
    );
    const cells = screen.getByTestId('moves-by-rating-tooltip-row-Qh7').querySelectorAll('td');
    expect(cells[0]?.textContent).toBe('Qh7');
    expect(cells[1]?.querySelector('svg')).toBeTruthy();
    expect(cells[2]?.textContent).toBe('Best');
    expect(cells[3]?.textContent).toBe('#3');
    expect(cells[4]?.textContent).toBe('90%');
  });

  it('renders only the top FlawChess move as a reference header', () => {
    render(
      <MovesByRatingTooltipContent
        label={2400}
        rows={[{ san: 'Nf6', probability: 0.42 }]}
        engineTopLines={[
          { san: 'Nf6', evalCp: 30, evalMate: null },
          { san: 'd5', evalCp: 25, evalMate: null },
        ]}
        qualityBySan={new Map([['Nf6', { quality: 'best', evalCp: 30, evalMate: null }]])}
      />,
    );
    const cells = screen.getByTestId('moves-by-rating-tooltip-engine').querySelectorAll('td');
    expect(cells[0]?.textContent).toBe('Nf6');
    expect(cells[1]?.querySelector('svg')).toBeTruthy();
    expect(cells[2]?.textContent).toBe('FlawChess');
    expect(cells[3]?.textContent).toBe('+0.3');
    expect(cells[4]?.textContent).toBe('42%');
  });

  it('omits the engine reference header when no engine lines are available', () => {
    render(
      <MovesByRatingTooltipContent
        label={2400}
        rows={[{ san: 'Nf6', probability: 0.42 }]}
        engineTopLines={[]}
        qualityBySan={new Map([['Nf6', { quality: 'best', evalCp: 30, evalMate: null }]])}
      />,
    );
    expect(screen.queryByTestId('moves-by-rating-tooltip-engine')).toBeNull();
  });
});

/**
 * Option A end-of-line label de-collision. spreadLabels nudges near-equal endpoints
 * apart so no two SANs overprint, while keeping each as close to its true y as the
 * min gap and the [minY, maxY] bounds allow.
 */
describe('spreadLabels (end-of-line label de-collision, Option A)', () => {
  const mk = (san: string, y: number): EndLabelDatum => ({ san, color: '#000', y });
  const gaps = (labels: EndLabelDatum[]): number[] => {
    const ys = labels.map((l) => l.y).sort((a, b) => a - b);
    return ys.slice(1).map((y, i) => y - ys[i]!);
  };

  it('leaves already-separated labels untouched', () => {
    const input = [mk('a', 10), mk('b', 60), mk('c', 120)];
    const out = spreadLabels(input, 0, 200);
    expect(out.map((l) => [l.san, l.y]).sort()).toEqual([
      ['a', 10],
      ['b', 60],
      ['c', 120],
    ]);
  });

  it('pushes two colliding labels apart to at least one line height', () => {
    // Both moves land at ~5% → nearly identical endpoint y (the screenshot's f3/Bxd6).
    const out = spreadLabels([mk('f3', 200), mk('Bxd6', 203)], 0, 260);
    for (const g of gaps(out)) expect(g).toBeGreaterThanOrEqual(MOVE_LABEL_LINE_HEIGHT);
  });

  it('keeps every gap >= one line height for a dense cluster', () => {
    const cluster = [mk('a', 100), mk('b', 101), mk('c', 102), mk('d', 103), mk('e', 104)];
    const out = spreadLabels(cluster, 0, 400);
    for (const g of gaps(out)) expect(g).toBeGreaterThanOrEqual(MOVE_LABEL_LINE_HEIGHT - 1e-9);
  });

  it('relaxes upward instead of overflowing the bottom bound', () => {
    // A collision right at the bottom edge must move labels UP, not past maxY.
    const maxY = 260;
    const out = spreadLabels([mk('x', 259), mk('y', 260)], 0, maxY);
    for (const l of out) expect(l.y).toBeLessThanOrEqual(maxY);
    for (const g of gaps(out)) expect(g).toBeGreaterThanOrEqual(MOVE_LABEL_LINE_HEIGHT - 1e-9);
  });

  it('does not mutate the input labels', () => {
    const input = [mk('a', 100), mk('b', 101)];
    const before = input.map((l) => l.y);
    spreadLabels(input, 0, 400);
    expect(input.map((l) => l.y)).toEqual(before);
  });
});

/**
 * Option B leader lines: when a label is nudged off its endpoint, a same-color
 * connector links it back to the line end; a label left on its endpoint gets none.
 */
describe('end-of-line leader lines (Option B)', () => {
  const flatCurve = (endValues: Record<string, number>): MoveCurvePoint[] =>
    [1100, 1500, 1900].map((elo) => ({
      elo,
      moveProbabilities: Object.fromEntries(
        Object.entries(endValues).map(([san, end]) => [san, end]),
      ),
    }));
  const q = (sans: string[]): Map<string, MoveQualityEval> =>
    new Map(sans.map((san) => [san, { quality: 'good', evalCp: 10, evalMate: null }]));

  it('draws leader lines for labels nudged apart by de-collision', () => {
    // f3 (5%) and Bxd6 (4.5%) collide at the right edge → at least one is nudged.
    const sans = ['O-O', 'f3', 'Bxd6'];
    const { container } = render(
      <MovesByRatingChart
        perElo={flatCurve({ 'O-O': 0.4, f3: 0.05, Bxd6: 0.045 })}
        playedSan={null}
        bestSan="O-O"
        selectedElo={1500}
        shownSans={sans}
        engineTopLines={[]}
        qualityBySan={q(sans)}
      />,
    );
    expect(container.querySelector('[data-testid="moves-by-rating-end-labels"]')).toBeTruthy();
    const leaders = container.querySelectorAll('[data-testid^="moves-by-rating-leader-"]');
    expect(leaders.length).toBeGreaterThan(0);
  });

  it('draws no leader lines when all endpoints are well separated', () => {
    const sans = ['O-O', 'f3', 'Bxd6'];
    const { container } = render(
      <MovesByRatingChart
        perElo={flatCurve({ 'O-O': 0.45, f3: 0.25, Bxd6: 0.05 })}
        playedSan={null}
        bestSan="O-O"
        selectedElo={1500}
        shownSans={sans}
        engineTopLines={[]}
        qualityBySan={q(sans)}
      />,
    );
    expect(container.querySelector('[data-testid="moves-by-rating-end-labels"]')).toBeTruthy();
    const leaders = container.querySelectorAll('[data-testid^="moves-by-rating-leader-"]');
    expect(leaders.length).toBe(0);
  });
});
