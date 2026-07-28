// @vitest-environment jsdom
/**
 * confetti.ts unit tests (Quick 260723-tqn).
 *
 * Behaviors verified:
 * 1. fireWinConfetti invokes the mocked canvas-confetti default export at
 *    least once.
 * 2. prefersReducedMotion returns true when matchMedia reports reduce.
 * 3. prefersReducedMotion returns false when matchMedia reports no-preference.
 * 4. prefersReducedMotion returns false (animate) when window.matchMedia is
 *    undefined.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const confettiMock = vi.fn();

vi.mock('canvas-confetti', () => ({
  default: confettiMock,
}));

function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

afterEach(() => {
  confettiMock.mockClear();
  vi.restoreAllMocks();
});

describe('confetti', () => {
  it('fireWinConfetti invokes canvas-confetti at least once', async () => {
    const { fireWinConfetti } = await import('../confetti');
    fireWinConfetti();
    expect(confettiMock).toHaveBeenCalled();
  });

  it('firePartialConfetti fires the same two bursts with strictly fewer particles than fireWinConfetti', async () => {
    const { fireWinConfetti, firePartialConfetti } = await import('../confetti');
    fireWinConfetti();
    const winCounts = confettiMock.mock.calls.map(([opts]) => opts.particleCount as number);
    confettiMock.mockClear();
    firePartialConfetti();
    const partialCounts = confettiMock.mock.calls.map(([opts]) => opts.particleCount as number);

    expect(partialCounts).toHaveLength(winCounts.length);
    partialCounts.forEach((count, i) => {
      expect(count).toBeLessThan(winCounts[i]!);
    });
  });

  it('prefersReducedMotion returns true when matchMedia reports reduce', async () => {
    stubMatchMedia(true);
    const { prefersReducedMotion } = await import('../confetti');
    expect(prefersReducedMotion()).toBe(true);
  });

  it('prefersReducedMotion returns false when matchMedia reports no-preference', async () => {
    stubMatchMedia(false);
    const { prefersReducedMotion } = await import('../confetti');
    expect(prefersReducedMotion()).toBe(false);
  });

  it('prefersReducedMotion returns false when window.matchMedia is undefined', async () => {
    const original = window.matchMedia;
    // @ts-expect-error -- deliberately deleting to simulate an environment without matchMedia
    delete window.matchMedia;
    const { prefersReducedMotion } = await import('../confetti');
    expect(prefersReducedMotion()).toBe(false);
    window.matchMedia = original;
  });
});
