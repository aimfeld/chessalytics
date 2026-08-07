// @vitest-environment jsdom
/**
 * EvalCoverageBadge tests (Phase 118-03 UAT fixes, updated Phase 119-03).
 *
 * Covers the states:
 * 1. Normal: "N of M analyzed" count render
 * 2. Incomplete: CPU icon has animate-pulse class (analyzedN < totalN)
 * 3. Complete: CPU icon does NOT have animate-pulse class (analyzedN === totalN)
 * 4. Low-coverage non-guest: NO button (background auto-enqueue handles it)
 * 5. Low-coverage guest: sees sign-up CTA (btn-coverage-signup)
 * 6. High-coverage guest: CTA hidden
 * 7. InfoPopover trigger rendered
 *
 * Note: "· K in progress" text and the inFlightCount prop were removed in
 * Phase 119-03. The CPU icon pulse is now the sole "analysis running" signal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { EvalCoverageBadge } from '../EvalCoverageBadge';

// The guest sign-up CTA calls useAuth().logoutForPromotion() before navigating
// (a guest JWT would otherwise bounce off /login). Mock useAuth so the badge can
// render without a full AuthProvider.
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ logoutForPromotion: vi.fn() }),
}));

// ── Wrapper ───────────────────────────────────────────────────────────────────

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

// Default props for convenience (incomplete: 5 of 10)
const defaultProps = {
  analyzedN: 5,
  totalN: 10,
  isGuest: false,
  isCoverageError: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EvalCoverageBadge', () => {
  it('renders analyzed/total count', () => {
    render(<EvalCoverageBadge {...defaultProps} />, { wrapper: makeWrapper() });
    const badge = screen.getByTestId('eval-coverage-badge');
    expect(badge).toBeDefined();
    expect(badge.textContent).toContain('5');
    expect(badge.textContent).toContain('10');
    expect(badge.textContent).toContain('analyzed');
  });

  it('CPU icon has animate-pulse when analyzedN < totalN (analysis incomplete)', () => {
    render(<EvalCoverageBadge {...defaultProps} analyzedN={5} totalN={10} />, {
      wrapper: makeWrapper(),
    });
    const badge = screen.getByTestId('eval-coverage-badge');
    // The Cpu svg is the first SVG inside the badge. Use getAttribute('class')
    // because SVGAnimatedString (jsdom) is not a plain string — .className would be [].
    const cpuIcon = badge.querySelector('svg');
    expect(cpuIcon).not.toBeNull();
    expect(cpuIcon!.getAttribute('class')).toContain('animate-pulse');
  });

  it('CPU icon does NOT have animate-pulse when analyzedN === totalN (complete)', () => {
    render(<EvalCoverageBadge {...defaultProps} analyzedN={10} totalN={10} />, {
      wrapper: makeWrapper(),
    });
    const badge = screen.getByTestId('eval-coverage-badge');
    const cpuIcon = badge.querySelector('svg');
    expect(cpuIcon).not.toBeNull();
    expect(cpuIcon!.getAttribute('class')).not.toContain('animate-pulse');
  });

  it('does not render "in progress" text', () => {
    render(<EvalCoverageBadge {...defaultProps} />, { wrapper: makeWrapper() });
    const badge = screen.getByTestId('eval-coverage-badge');
    expect(badge.textContent).not.toContain('in progress');
  });

  it('shows NO button for non-guest below threshold (auto-enqueue handles it)', () => {
    // 5/10 = 50% < 80% LOW_COVERAGE_THRESHOLD, but non-guests get no button —
    // recent games are analyzed automatically in the background.
    render(<EvalCoverageBadge {...defaultProps} analyzedN={5} totalN={10} />, {
      wrapper: makeWrapper(),
    });
    expect(screen.queryByTestId('btn-coverage-signup')).toBeNull();
  });

  it('shows sign-up CTA for guest when coverage is below threshold', () => {
    // 5/10 = 50% < 80% threshold → guest sign-up CTA (their only path to analysis)
    render(<EvalCoverageBadge {...defaultProps} analyzedN={5} totalN={10} isGuest={true} />, {
      wrapper: makeWrapper(),
    });
    const btn = screen.getByTestId('btn-coverage-signup');
    expect(btn).toBeDefined();
    expect(btn.getAttribute('aria-label')).toContain('Sign up');
  });

  it('hides guest CTA when coverage is at or above threshold', () => {
    // 9/10 = 90% ≥ 80% → no CTA even for a guest
    render(<EvalCoverageBadge {...defaultProps} analyzedN={9} totalN={10} isGuest={true} />, {
      wrapper: makeWrapper(),
    });
    expect(screen.queryByTestId('btn-coverage-signup')).toBeNull();
  });

  it('renders the InfoPopover trigger', () => {
    render(<EvalCoverageBadge {...defaultProps} />, { wrapper: makeWrapper() });
    expect(screen.getByTestId('eval-coverage-badge-info')).toBeDefined();
  });
});
