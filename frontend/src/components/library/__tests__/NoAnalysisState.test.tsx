// @vitest-environment jsdom
/**
 * NoAnalysisState tests (Phase 118-03, updated 260615-q1x, 260616-ey1).
 *
 * Tests the four branches (isGuest prop removed in 260616-ey1 — guests now get
 * the Analyze button just like authenticated users):
 * 1. Not-analyzed, not in-flight, no active job → "Analyze" button with btn-analyze-game-{gameId}
 *    fires the tier-1 mutation on click; onInFlightChange(true) called optimistically before mutate
 * 2. Not-analyzed, optimistic in-flight (isInFlight=true) → pulsing "Pending…" span
 * 3. Not-analyzed, activeEvalStatus="leased" → pulsing "Analyzing…" span (worker running)
 * 4. Already analyzed → returns null (no DOM)
 *
 * 260615-q1x: three-state pill: Analyze button → Pending… (optimistic/pending) → Analyzing… (leased)
 * 260616-ey1: remove guest sign-up CTA; guests see Analyze button for their own games (QUEUE-08).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { NoAnalysisState } from '../NoAnalysisState';

// ── Mock useTier1Enqueue ───────────────────────────────────────────────────────

const mockMutate = vi.fn();

vi.mock('@/hooks/useEnqueueGame', () => ({
  useTier1Enqueue: () => ({ mutate: mockMutate, isPending: false }),
}));

// ── Wrapper ────────────────────────────────────────────────────────────────────

function makeWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  return function Wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NoAnalysisState', () => {
  it('not-analyzed, not in-flight: renders btn-analyze-game-{gameId}', () => {
    render(
      <NoAnalysisState gameId={7} isAnalyzed={false} isInFlight={false} />,
      { wrapper: makeWrapper() },
    );
    const btn = screen.getByTestId('btn-analyze-game-7');
    expect(btn).toBeDefined();
  });

  it('not-analyzed, not in-flight: clicking analyze button fires tier-1 mutation optimistically', () => {
    const onInFlightChange = vi.fn();
    render(
      <NoAnalysisState
        gameId={7}
        isAnalyzed={false}
        isInFlight={false}
        onInFlightChange={onInFlightChange}
      />,
      { wrapper: makeWrapper() },
    );
    fireEvent.click(screen.getByTestId('btn-analyze-game-7'));
    // onInFlightChange(true) is called BEFORE mutate (optimistic update).
    expect(onInFlightChange).toHaveBeenCalledWith(true);
    expect(mockMutate).toHaveBeenCalled();
  });

  it('not-analyzed, in-flight (optimistic): renders pulsing Pending… span with analyzing-{gameId}', () => {
    // isInFlight=true with no activeEvalStatus → "Pending…" (optimistic state)
    render(
      <NoAnalysisState gameId={99} isAnalyzed={false} isInFlight={true} />,
      { wrapper: makeWrapper() },
    );
    const span = screen.getByTestId('analyzing-99');
    expect(span).toBeDefined();
    expect(span.textContent).toContain('Pending');
    // No analyze button when pill is showing
    expect(screen.queryByTestId('btn-analyze-game-99')).toBeNull();
  });

  it('not-analyzed, activeEvalStatus="pending": renders pulsing Pending… span', () => {
    render(
      <NoAnalysisState
        gameId={55}
        isAnalyzed={false}
        activeEvalStatus="pending"
      />,
      { wrapper: makeWrapper() },
    );
    const span = screen.getByTestId('analyzing-55');
    expect(span).toBeDefined();
    expect(span.textContent).toContain('Pending');
    expect(screen.queryByTestId('btn-analyze-game-55')).toBeNull();
  });

  it('not-analyzed, activeEvalStatus="leased": renders pulsing Analyzing… span', () => {
    // activeEvalStatus="leased" → worker is actively running → "Analyzing…"
    render(
      <NoAnalysisState
        gameId={77}
        isAnalyzed={false}
        activeEvalStatus="leased"
      />,
      { wrapper: makeWrapper() },
    );
    const span = screen.getByTestId('analyzing-77');
    expect(span).toBeDefined();
    expect(span.textContent).toContain('Analyzing');
    expect(screen.queryByTestId('btn-analyze-game-77')).toBeNull();
  });

  it('analyzed: returns null — no DOM node rendered', () => {
    const { container } = render(
      <NoAnalysisState gameId={5} isAnalyzed={true} />,
      { wrapper: makeWrapper() },
    );
    // Null render → empty container
    expect(container.firstChild).toBeNull();
  });
});
