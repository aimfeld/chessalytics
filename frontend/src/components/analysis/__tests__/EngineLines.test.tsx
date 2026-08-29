// @vitest-environment jsdom
/**
 * Phase 137 Plan 02 — EngineLines render tests.
 * Updated Quick 260627-mt8: depth badge moved to the engine info line (Analysis.tsx),
 * so EngineLines no longer takes a `depth` prop or renders a `d{depth}` badge.
 *
 * Verifies:
 *  (a) two fixture PV lines render two rows with correct score (badge) format
 *  (c) fireEvent.click on engine-line-0-move-0 calls onMoveClick("e2","e4")
 *  (d) isAnalyzing && empty pvLines → shows "engine-lines-analyzing"
 *      isAnalyzing && non-empty pvLines → does NOT show "engine-lines-analyzing"
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngineLines, EngineLinesSkeleton } from '../EngineLines';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { PvLine } from '@/hooks/uciParser';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const LINE_CP: PvLine = {
  multipv: 1,
  depth: 20,
  moves: ['e2e4', 'd7d5', 'e4d5'],
  evalCp: 142,
  evalMate: null,
};

const LINE_MATE: PvLine = {
  multipv: 2,
  depth: 20,
  moves: ['d1h5', 'f7f6', 'h5e5'],
  evalCp: null,
  evalMate: 3,
};

const TWO_LINES: PvLine[] = [LINE_CP, LINE_MATE];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EngineLines', () => {
  it('(a) renders two PV lines with correct score format', () => {
    render(
      <EngineLines
        pvLines={TWO_LINES}
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );

    // Line 0 — evalCp 142 → "+1.4" (1-digit)
    expect(screen.getByText('+1.4')).toBeTruthy();
    // Line 1 — evalMate 3 → "#+3"
    expect(screen.getByText('#+3')).toBeTruthy();
  });

  it('(c) clicking engine-line-0-move-0 calls onMoveClick(["e2e4"])', () => {
    const onMoveClick = vi.fn();
    render(
      <EngineLines
        pvLines={TWO_LINES}
        isAnalyzing={false}
        onMoveClick={onMoveClick}
      />,
    );

    const chip = screen.getByTestId('engine-line-0-move-0');
    fireEvent.click(chip);
    expect(onMoveClick).toHaveBeenCalledTimes(1);
    expect(onMoveClick).toHaveBeenCalledWith(['e2e4']);
  });

  it('clicking a later move passes the full UCI prefix up to that move', () => {
    // LINE_CP = ['e2e4', 'd7d5', 'e4d5']; clicking move index 2 must graft the
    // whole line up to it (not just the single clicked move) — the UAT bug fix.
    const onMoveClick = vi.fn();
    render(
      <EngineLines
        pvLines={[LINE_CP]}
        isAnalyzing={false}
        onMoveClick={onMoveClick}
      />,
    );

    fireEvent.click(screen.getByTestId('engine-line-0-move-2'));
    expect(onMoveClick).toHaveBeenCalledWith(['e2e4', 'd7d5', 'e4d5']);
  });

  it('(d) isAnalyzing && empty pvLines → shows analyzing indicator', () => {
    render(
      <EngineLines
        pvLines={[]}
        isAnalyzing={true}
        onMoveClick={vi.fn()}
      />,
    );
    // Quick 260627-r9g item 3: the "Analyzing…" text is now a skeleton placeholder.
    expect(screen.getByTestId('engine-lines-analyzing')).toBeTruthy();
    expect(screen.queryByText('Analyzing…')).toBeNull();
  });

  it('(d) isAnalyzing && non-empty pvLines → does NOT show analyzing indicator', () => {
    render(
      <EngineLines
        pvLines={TWO_LINES}
        isAnalyzing={true}
        onMoveClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('engine-lines-analyzing')).toBeNull();
  });

  it('move chips are <button> elements (semantic HTML)', () => {
    render(
      <EngineLines
        pvLines={[LINE_CP]}
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );
    const chip = screen.getByTestId('engine-line-0-move-0');
    expect(chip.tagName.toLowerCase()).toBe('button');
  });

  it('negative evalCp displays without leading +', () => {
    const negativeLine: PvLine = {
      multipv: 1,
      depth: 15,
      moves: ['e7e5'],
      evalCp: -33,
      evalMate: null,
    };
    render(
      <EngineLines
        pvLines={[negativeLine]}
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );
    expect(screen.getByText('-0.3')).toBeTruthy();
  });

  it('negative evalMate displays as #-N', () => {
    const losingMate: PvLine = {
      multipv: 1,
      depth: 15,
      moves: ['e7e5'],
      evalCp: null,
      evalMate: -2,
    };
    render(
      <EngineLines
        pvLines={[losingMate]}
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );
    expect(screen.getByText('#-2')).toBeTruthy();
  });

  it('!isAnalyzing && empty pvLines → renders empty (no spinner, no error)', () => {
    render(
      <EngineLines
        pvLines={[]}
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('engine-lines-analyzing')).toBeNull();
    expect(screen.queryByText('Analyzing…')).toBeNull();
  });

  it('with baseFen, move chips are tooltip-wrapped and still clickable (thl item 5)', () => {
    const onMoveClick = vi.fn();
    render(
      <TooltipProvider>
        <EngineLines
          pvLines={[LINE_CP]}
          isAnalyzing={false}
          baseFen={START_FEN}
          onMoveClick={onMoveClick}
        />
      </TooltipProvider>,
    );
    const chip = screen.getByTestId('engine-line-0-move-0');
    expect(chip.tagName.toLowerCase()).toBe('button');
    fireEvent.click(chip);
    expect(onMoveClick).toHaveBeenCalledWith(['e2e4']);
  });

  it('reads per-line evalCp/evalMate not a non-existent score field', () => {
    // This test verifies the contract at compile time via the PvLine fixture.
    // If PvLine had a `score` field and EngineLines used it, this fixture
    // without a `score` field would fail TypeScript.
    const lineWithOnlyCp: PvLine = {
      multipv: 1,
      depth: 10,
      moves: ['g1f3'],
      evalCp: 50,
      evalMate: null,
    };
    render(
      <EngineLines
        pvLines={[lineWithOnlyCp]}
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );
    expect(screen.getByText('+0.5')).toBeTruthy();
  });

  it('chevron expands a >5-ply line to reveal the rest of the PV', () => {
    // 7 plies — collapsed shows the first 5; the expand chevron reveals 6 & 7.
    const longLine: PvLine = {
      multipv: 1,
      depth: 22,
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4'],
      evalCp: 20,
      evalMate: null,
    };
    render(
      <EngineLines
        pvLines={[longLine]}
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );

    // Collapsed: moves 5 and 6 are not rendered.
    expect(screen.queryByTestId('engine-line-0-move-5')).toBeNull();
    expect(screen.getByTestId('engine-line-0-move-4')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engine-line-0-expand'));

    // Expanded: the remaining plies are now rendered.
    expect(screen.getByTestId('engine-line-0-move-5')).toBeTruthy();
    expect(screen.getByTestId('engine-line-0-move-6')).toBeTruthy();
  });

  it('no chevron when the line is <= 5 plies', () => {
    render(
      <EngineLines
        pvLines={[LINE_CP]} // 3 plies
        isAnalyzing={false}
        onMoveClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('engine-line-0-expand')).toBeNull();
  });
});

// ─── G-213-34 (supersedes D-12): EngineLinesSkeleton reads no download state ──

describe('EngineLinesSkeleton', () => {
  it('renders the pulsing placeholder rows (the ONLY thing this skeleton ever renders now)', () => {
    render(<EngineLinesSkeleton testId="skel" />);
    const el = screen.getByTestId('skel');
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('Loading engine lines');
    expect(screen.queryByTestId('skel-progress')).toBeNull();
  });

  it('the outer container className expression is stable for the default, compact, and three-row variants', () => {
    render(<EngineLinesSkeleton testId="default-variant" />);
    render(<EngineLinesSkeleton testId="compact-variant" compact />);
    render(<EngineLinesSkeleton testId="three-row-variant" rows={3} />);

    expect(screen.getByTestId('default-variant').className).toContain('min-h-[60px]');
    expect(screen.getByTestId('compact-variant').className).toContain('min-h-[50px]');
    expect(screen.getByTestId('three-row-variant').className).toContain('min-h-[90px]');
  });

  it('aria-busy and aria-label are always set', () => {
    render(<EngineLinesSkeleton testId="skel-aria" />);
    const el = screen.getByTestId('skel-aria');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('Loading engine lines');
  });
});
